import { type Data, string } from "../../src/lib/protocol";
import path from "node:path";

interface Entry {
  directory: boolean;
  data: string;
  modified: number;
}

/**
Model native filesystem APIs entirely in memory; never read or write the operator's filesystem.
*/
export class CodexFiles {
  private entries = new Map<string, Entry>([["/", { directory: true, data: "", modified: 0 }]]);

  /**
Require a normalized absolute native path.
@param value - Native path parameter.
@returns Canonical virtual path.
*/
  private path(value: unknown) {
    const text = string(value);

    if (!path.posix.isAbsolute(text) || path.posix.normalize(text) !== text) {
      throw new Error("Expected normalized absolute path");
    }

    return text;
  }

  /**
Read a virtual entry or reject a missing path.
@param filename - Absolute virtual path.
@returns Entry metadata and content.
*/
  private get(filename: string) {
    const entry = this.entries.get(filename);

    if (!entry) {
      throw new Error(`No such file or directory: ${filename}`);
    }

    return entry;
  }

  /**
Create directories with native recursive defaults.
@param filename - Destination.
@param isRecursive - Whether missing ancestors may be created.
*/
  private mkdir(filename: string, isRecursive: boolean) {
    const existing = this.entries.get(filename);

    if (existing) {
      if (!isRecursive || !existing.directory) {
        throw new Error("Path already exists");
      }

      return;
    }

    if (isRecursive && !this.entries.has(path.posix.dirname(filename))) {
      this.mkdir(path.posix.dirname(filename), true);
    }

    if (!this.get(path.posix.dirname(filename)).directory) {
      throw new Error("Parent is not a directory");
    }

    this.entries.set(filename, { directory: true, data: "", modified: Date.now() });
  }

  /**
Apply a write only when its parent directory exists.
@param filename - Destination path.
@param data - Native base64 payload.
*/
  private write(filename: string, data: string) {
    if (!this.get(path.posix.dirname(filename)).directory || this.entries.get(filename)?.directory) {
      throw new Error("Invalid file destination");
    }

    if (Buffer.from(data, "base64").toString("base64") !== data) {
      throw new Error("Invalid base64 data");
    }

    this.entries.set(filename, { directory: false, data, modified: Date.now() });
  }

  /**
Copy an independent entry tree without executing host filesystem operations.
@param params - Native copy parameters.
@returns Empty native receipt.
*/
  private copy(params: Data) {
    const source = this.path(params.sourcePath);
    const destination = this.path(params.destinationPath);
    const entry = this.get(source);
    const children = this.entries
      .entries()
      .filter(([name]) => name.startsWith(source + "/"))
      .toArray();

    if (destination === source || destination.startsWith(source + "/")) {
      throw new Error("Cannot copy a path into itself");
    }

    if (entry.directory && params.recursive !== true) {
      throw new Error("Directory copy requires recursive");
    }

    if (entry.directory) {
      this.mkdir(destination, true);

      for (const [name, child] of children) {
        this.entries.set(destination + name.slice(source.length), structuredClone(child));
      }
    } else {
      this.write(destination, entry.data);
    }

    return {};
  }

  /**
Remove a virtual tree with native force and recursion defaults.
@param filename - Target path.
@param params - Native remove flags.
*/
  private remove(filename: string, params: Data) {
    const children = this.entries
      .keys()
      .filter((name) => name.startsWith(filename + "/"))
      .toArray();

    if (params.force === false) {
      this.get(filename);
    }

    if (params.recursive === false && this.entries.get(filename)?.directory) {
      throw new Error("Directory removal requires recursive");
    }

    for (const child of children) {
      this.entries.delete(child);
    }

    this.entries.delete(filename);
  }

  /**
Run the seven native filesystem request methods against the virtual tree.
@param method - Native filesystem method.
@param params - Schema-validated parameters.
@returns Native response.
*/
  execute(method: string, params: Data): unknown {
    const filename = method === "fs/copy" ? "/" : this.path(params.path);

    switch (method) {
      case "fs/createDirectory": {
        this.mkdir(filename, params.recursive !== false);

        return {};
      }

      case "fs/writeFile": {
        this.write(filename, string(params.dataBase64));

        return {};
      }

      case "fs/readFile": {
        const entry = this.get(filename);

        if (entry.directory) {
          throw new Error("Cannot read a directory as a file");
        }

        return { dataBase64: entry.data };
      }

      case "fs/getMetadata": {
        const entry = this.get(filename);

        return {
          isDirectory: entry.directory,
          isFile: !entry.directory,
          isSymlink: false,
          createdAtMs: entry.modified,
          modifiedAtMs: entry.modified,
        };
      }

      case "fs/readDirectory": {
        if (!this.get(filename).directory) {
          throw new Error("Not a directory");
        }

        return {
          entries: this.entries
            .entries()
            .filter(([name]) => name !== filename && path.posix.dirname(name) === filename)
            .map(([name, entry]) => ({
              fileName: path.posix.basename(name),
              isFile: !entry.directory,
              isDirectory: entry.directory,
            }))
            .toArray(),
        };
      }

      case "fs/copy": {
        return this.copy(params);
      }

      case "fs/remove": {
        this.remove(filename, params);

        return {};
      }

      default: {
        throw new Error(`SIMULATOR_UNIMPLEMENTED: ${method}; supply an explicit scenario`);
      }
    }
  }
}
