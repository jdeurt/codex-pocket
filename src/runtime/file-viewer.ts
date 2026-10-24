import { type PointerEvent, type SyntheticEvent, type RefObject } from "react";
import { t } from "try";
import {
  initialFileView,
  fileMetadataSchema,
  movedFileGesture,
  isFileSwipeComplete,
  type FilePointer,
} from "../state/file-viewer";
import { scopedPocketUrl } from "../state/pocket";
import { pocketHref } from "../lib/pockets";
import { observable } from "./stores";

export interface FileViewerOptions {
  filename: string;
  pocketId: string;
  overlay: boolean;
  router: { back: () => void; push: (url: string) => void };
}

/** Fetch and validate file metadata within a caller-owned request lifetime.
@param url - Explicitly scoped file endpoint.
@param signal - Mounted view's cancellation signal.
@returns Validated metadata or a transport/validation failure.
*/
async function readMetadata(url: string, signal: AbortSignal) {
  const response = await fetch(`${url}&metadata=1`, { signal });

  if (!response.ok) {
    throw new Error("File is unavailable.");
  }

  return fileMetadataSchema.parse(await response.json());
}

/**
Own a mounted file view's network request, dialog and native edge gestures.
*/
export class FileViewerRuntime {
  private controller?: AbortController;
  private drag?: FilePointer;

  /** Publish a read only while its exact mounted request still owns the view.
  @param controller - Abort controller allocated by this mount.
  */
  private load = async (controller: AbortController) => {
    const result = await t(readMetadata, this.url, controller.signal);

    if (controller.signal.aborted || this.controller !== controller) {
      return;
    }

    this.store.setState(
      result.ok
        ? { file: result.value, error: "" }
        : {
            error: result.error instanceof Error ? result.error.message : "File is unavailable.",
          }
    );
  };

  /**
  Cancel a request when its view unmounts.
  */
  private disconnect = () => {
    this.controller?.abort();
  };

  readonly dialog: RefObject<HTMLDialogElement | null> = { current: null };
  readonly store = observable(initialFileView());
  readonly url: string;

  /** Start network and dialog effects after the element has mounted.
  @returns Mounted request cleanup.
  */
  connect = () => {
    this.controller = new AbortController();
    void this.load(this.controller);
    this.dialog.current?.showModal();

    return this.disconnect;
  };

  /**
  Return to the explicit owning conversation or retained overlay history.
  */
  back = () => {
    if (this.options.overlay) {
      this.options.router.back();
    } else {
      this.options.router.push(pocketHref(this.options.pocketId));
    }
  };

  /** Route a native dialog cancellation through the same navigation owner.
  @param event - Native dialog cancellation.
  */
  cancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    this.back();
  };

  /** Capture deliberate edge gestures while preserving native text selection.
  @param event - Native pointer down.
  */
  down = (event: PointerEvent<HTMLDialogElement>) => {
    if (
      !(event.target instanceof HTMLElement) ||
      !event.target.classList.contains("file-viewer-edge") ||
      globalThis.getSelection()?.toString()
    ) {
      return;
    }

    event.preventDefault();
    this.drag = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Publish the pure gesture decision and perform native pointer capture when needed.
  @param event - Latest pointer coordinates.
  */
  move = (event: PointerEvent<HTMLDialogElement>) => {
    if (!this.drag) {
      return;
    }

    const next = movedFileGesture(this.drag, { x: event.clientX, y: event.clientY });

    this.store.setState({ offset: next.offset });

    if (next.isCancelled) {
      this.drag = undefined;
    }

    if (next.shouldCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  /**
  Release the drag and execute its back-navigation decision.
  */
  up = () => {
    const shouldNavigate = isFileSwipeComplete(this.store.getState().offset, window.innerWidth);

    this.cancelGesture();

    if (shouldNavigate) {
      this.back();
    }
  };

  /**
  Clear native gesture ownership and its visible offset.
  */
  cancelGesture = () => {
    this.drag = undefined;
    this.store.setState({ offset: 0 });
  };

  /** Retain explicit route and navigation inputs without starting effects.
  @param options - Fixed route identity and navigation owner for this mount.
  */
  constructor(private readonly options: FileViewerOptions) {
    this.url = scopedPocketUrl(options.pocketId, `/api/files?path=${encodeURIComponent(options.filename)}`);
  }
}
