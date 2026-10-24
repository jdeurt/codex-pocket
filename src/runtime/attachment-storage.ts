import { type DraftAttachment, type SavedDraft, type StoredDraft, storedDraftSchema } from "../lib/draft-attachments";
import { t } from "try";

/** Create the initial store during the browser's version-change transaction.
@param request - Database opening request owning the upgrade.
*/
function createAttachmentStore(request: IDBOpenDBRequest) {
  request.result.createObjectStore("drafts");
}

/** Deliver the owned database handle after a successful open.
@param request - Completed browser open request.
@param resolve - Caller waiting for the database handle.
*/
function openedDatabase(request: IDBOpenDBRequest, resolve: (db: IDBDatabase) => void) {
  resolve(request.result);
}

/** Open the device database without creating a closure around its events.
@returns Database handle whose caller owns transaction cleanup.
*/
function database() {
  const completion = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open("pocket-attachments", 1);

  request.onupgradeneeded = createAttachmentStore.bind(undefined, request);
  request.onsuccess = openedDatabase.bind(undefined, request, completion.resolve);
  request.addEventListener(
    "error",
    completion.reject.bind(
      undefined,
      new Error("Couldn't save files on this device. Allow browser storage and try again.")
    )
  );

  return completion.promise;
}

/** Read original file bytes before opening a storage transaction.
@param entry - Draft attachment with its original browser file.
@returns Serializable attachment with complete original bytes.
*/
async function storedAttachment(entry: DraftAttachment): Promise<StoredDraft["files"][number]> {
  return { ...entry, file: { name: entry.file.name, type: entry.file.type, bytes: await entry.file.arrayBuffer() } };
}

/** Reconstruct native files only at the browser resource boundary.
@param entry - Validated persisted attachment.
@returns Draft attachment with original name, type and bytes.
*/
function restoredFile(entry: StoredDraft["files"][number]): DraftAttachment {
  return { ...entry, file: new File([entry.file.bytes], entry.file.name, { type: entry.file.type }) };
}

/** Validate a completed transaction before returning its durable value.
@param stored - Explicit write payload or undefined for a read.
@param request - Completed database operation.
@param completion - Caller awaiting validated storage data.
*/
function completedTransaction(
  stored: StoredDraft | undefined,
  request: IDBRequest,
  completion: PromiseWithResolvers<StoredDraft>
) {
  const result = storedDraftSchema.safeParse(stored ?? request.result ?? { files: [] });

  if (result.success) {
    completion.resolve(result.data);
  } else {
    completion.reject(new Error("Saved attachments could not be read.", { cause: result.error }));
  }
}

/** Execute one prepared transaction and report either its completion or its failure.
@param db - Database handle owned by the caller.
@param parent - Conversation namespace.
@param stored - Serialized write payload or undefined for a read.
@returns Validated stored draft after the transaction completes.
*/
function draftTransaction(db: IDBDatabase, parent: string, stored?: StoredDraft) {
  const completion = Promise.withResolvers<StoredDraft>();
  const transaction = db.transaction("drafts", stored ? "readwrite" : "readonly");
  const store = transaction.objectStore("drafts");
  const request = stored ? store.put(stored, parent) : store.get(parent);
  const failed = completion.reject.bind(
    undefined,
    new Error("Couldn't save files on this device. Free up browser storage and try again.")
  );

  transaction.oncomplete = completedTransaction.bind(undefined, stored, request, completion);
  transaction.addEventListener("error", failed);
  transaction.addEventListener("abort", failed);

  return completion.promise;
}

/** Serialize before opening storage and close the database before propagating the result.
@param parent - Conversation namespace.
@param value - Draft to write or undefined to restore.
@returns Draft containing the original file bytes.
*/
export async function savedDraft(parent: string, value?: SavedDraft): Promise<SavedDraft> {
  const stored = value && { ...value, files: await Promise.all(Array.from(value.files, storedAttachment)) };
  const db = await database();
  const result = await t(draftTransaction, db, parent, stored);

  db.close();

  if (!result.ok) {
    throw result.error;
  }

  return { ...result.value, files: Array.from(result.value.files, restoredFile) };
}
