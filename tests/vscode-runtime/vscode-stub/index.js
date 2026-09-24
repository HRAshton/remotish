class DisposableImpl {
  constructor(callOnDispose = () => {}) {
    this.callOnDispose = callOnDispose;
    this.disposed = false;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.callOnDispose();
  }

  static from(...items) {
    return new DisposableImpl(() => {
      for (const item of [...items].reverse()) {
        item.dispose();
      }
    });
  }
}

export const Disposable = DisposableImpl;

export class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return new DisposableImpl(() => this.listeners.delete(listener));
    };
  }

  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

export class Uri {
  constructor({ scheme, authority = '', path = '', query = '', fragment = '' }) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static from(parts) {
    return new Uri(parts);
  }

  static joinPath(base, ...segments) {
    const suffix = segments
      .map((segment) => String(segment).replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
    const root = base.path.replace(/\/+$/g, '');
    return base.with({ path: suffix ? `${root}/${suffix}` : root || '/' });
  }

  with(change) {
    return new Uri({
      scheme: change.scheme ?? this.scheme,
      authority: change.authority ?? this.authority,
      path: change.path ?? this.path,
      query: change.query ?? this.query,
      fragment: change.fragment ?? this.fragment,
    });
  }

  toString() {
    const query = this.query ? `?${this.query}` : '';
    const fragment = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
  }
}

export const FileType = Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });
export const FilePermission = Object.freeze({ Readonly: 1 });
export const FileChangeType = Object.freeze({ Changed: 1, Created: 2, Deleted: 3 });
export const StatusBarAlignment = Object.freeze({ Left: 1, Right: 2 });

export class FileSystemError extends Error {
  constructor(message, code = 'Unknown') {
    super(message);
    this.code = code;
  }

  static FileNotFound(value) {
    return new FileSystemError(`FileNotFound: ${stringify(value)}`, 'FileNotFound');
  }
  static FileExists(value) {
    return new FileSystemError(`FileExists: ${stringify(value)}`, 'FileExists');
  }
  static FileNotADirectory(value) {
    return new FileSystemError(`FileNotADirectory: ${stringify(value)}`, 'FileNotADirectory');
  }
  static FileIsADirectory(value) {
    return new FileSystemError(`FileIsADirectory: ${stringify(value)}`, 'FileIsADirectory');
  }
  static NoPermissions(value) {
    return new FileSystemError(`NoPermissions: ${stringify(value)}`, 'NoPermissions');
  }
  static Unavailable(value) {
    return new FileSystemError(`Unavailable: ${stringify(value)}`, 'Unavailable');
  }
}

export class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

export class TimelineItem {
  constructor(label, timestamp) {
    this.label = label;
    this.timestamp = timestamp;
  }
}

const commandHandlers = new Map();
const fileSystemProviders = new Map();
const timelineProviders = [];
const sourceControls = [];
const statusBarItems = [];
const externalCommands = [];
const infoMessages = [];
const warningMessages = [];
const errorMessages = [];
const quickPickResponses = [];
const inputBoxResponses = [];
const warningResponses = [];
const storageFiles = new Map();
const storageDirectories = new Set();
const logOutputChannels = [];
const installedExtensions = [];
const extensionsChanged = new EventEmitter();
const workspaceFoldersChanged = new EventEmitter();

export const extensions = {
  get all() {
    return [...installedExtensions];
  },
  getExtension(id) {
    const normalized = String(id).toLowerCase();
    return installedExtensions.find((extension) => extension.id.toLowerCase() === normalized);
  },
  onDidChange: extensionsChanged.event,
};

export const commands = {
  registerCommand(command, callback) {
    commandHandlers.set(command, callback);
    return new DisposableImpl(() => commandHandlers.delete(command));
  },
  async executeCommand(command, ...args) {
    const handler = commandHandlers.get(command);
    if (handler) {
      return handler(...args);
    }
    externalCommands.push({ command, args });
    return undefined;
  },
};

export const workspace = {
  workspaceFolders: undefined,
  onDidChangeWorkspaceFolders: workspaceFoldersChanged.event,
  fs: {
    async createDirectory(uri) {
      storageDirectories.add(storageKey(uri));
    },
    async stat(uri) {
      const key = storageKey(uri);
      const content = storageFiles.get(key);
      if (content) {
        return { type: FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
      }
      if (storageDirectories.has(key) || hasStorageChild(key)) {
        return { type: FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }
      throw FileSystemError.FileNotFound(uri);
    },
    async readDirectory(uri) {
      const key = storageKey(uri);
      if (!storageDirectories.has(key) && !hasStorageChild(key)) {
        throw FileSystemError.FileNotFound(uri);
      }
      const prefix = `${key}/`;
      const children = new Map();
      for (const fileKey of storageFiles.keys()) {
        if (!fileKey.startsWith(prefix)) {
          continue;
        }
        const relative = fileKey.slice(prefix.length);
        const [name, ...rest] = relative.split('/');
        if (name) {
          children.set(name, rest.length === 0 ? FileType.File : FileType.Directory);
        }
      }
      for (const directoryKey of storageDirectories) {
        if (!directoryKey.startsWith(prefix)) {
          continue;
        }
        const relative = directoryKey.slice(prefix.length);
        const name = relative.split('/', 1)[0];
        if (name) {
          children.set(name, FileType.Directory);
        }
      }
      return [...children.entries()];
    },
    async readFile(uri) {
      const content = storageFiles.get(storageKey(uri));
      if (!content) {
        throw FileSystemError.FileNotFound(uri);
      }
      return new Uint8Array(content);
    },
    async writeFile(uri, content) {
      storageFiles.set(storageKey(uri), new Uint8Array(content));
    },
    async delete(uri, options = {}) {
      const key = storageKey(uri);
      if (storageFiles.delete(key)) {
        return;
      }
      if (options.recursive && (storageDirectories.has(key) || hasStorageChild(key))) {
        const prefix = `${key}/`;
        for (const fileKey of [...storageFiles.keys()]) {
          if (fileKey.startsWith(prefix)) {
            storageFiles.delete(fileKey);
          }
        }
        for (const directoryKey of [...storageDirectories]) {
          if (directoryKey === key || directoryKey.startsWith(prefix)) {
            storageDirectories.delete(directoryKey);
          }
        }
        return;
      }
      if (storageDirectories.delete(key)) {
        return;
      }
      throw FileSystemError.FileNotFound(uri);
    },
    async rename(oldUri, newUri, options = {}) {
      const oldKey = storageKey(oldUri);
      const newKey = storageKey(newUri);
      const content = storageFiles.get(oldKey);
      if (!content) {
        throw FileSystemError.FileNotFound(oldUri);
      }
      if (!options.overwrite && storageFiles.has(newKey)) {
        throw FileSystemError.FileExists(newUri);
      }
      storageFiles.set(newKey, new Uint8Array(content));
      storageFiles.delete(oldKey);
    },
  },
  registerTimelineProvider(scheme, provider) {
    const registration = { scheme, provider };
    timelineProviders.push(registration);
    return new DisposableImpl(() => {
      const index = timelineProviders.indexOf(registration);
      if (index >= 0) {
        timelineProviders.splice(index, 1);
      }
    });
  },
  registerFileSystemProvider(scheme, provider, options) {
    fileSystemProviders.set(scheme, { provider, options });
    return new DisposableImpl(() => fileSystemProviders.delete(scheme));
  },
};

export const scm = {
  createSourceControl(id, label, rootUri) {
    const groups = [];
    const sourceControl = {
      id,
      label,
      rootUri,
      inputBox: { value: '', placeholder: '', enabled: true, visible: true },
      count: undefined,
      acceptInputCommand: undefined,
      quickDiffProvider: undefined,
      actionButton: undefined,
      historyProvider: undefined,
      createResourceGroup(groupId, groupLabel) {
        const group = {
          id: groupId,
          label: groupLabel,
          resourceStates: [],
          hideWhenEmpty: undefined,
          dispose() {},
        };
        groups.push(group);
        return group;
      },
      dispose() {
        const index = sourceControls.indexOf(sourceControl);
        if (index >= 0) {
          sourceControls.splice(index, 1);
        }
      },
      __groups: groups,
    };
    sourceControls.push(sourceControl);
    return sourceControl;
  },
};

export const window = {
  createOutputChannel(name) {
    const entries = [];
    const channel = {
      name,
      entries,
      error(message, error) {
        entries.push({ level: 'error', message, error });
      },
      dispose() {
        const index = logOutputChannels.indexOf(channel);
        if (index >= 0) {
          logOutputChannels.splice(index, 1);
        }
      },
    };
    logOutputChannels.push(channel);
    return channel;
  },
  createStatusBarItem() {
    const item = {
      text: '',
      tooltip: undefined,
      command: undefined,
      visible: false,
      show() {
        this.visible = true;
      },
      hide() {
        this.visible = false;
      },
      dispose() {
        const index = statusBarItems.indexOf(item);
        if (index >= 0) {
          statusBarItems.splice(index, 1);
        }
      },
    };
    statusBarItems.push(item);
    return item;
  },
  async showQuickPick(items) {
    const response = quickPickResponses.shift();
    if (typeof response === 'number') {
      return items[response];
    }
    if (typeof response === 'string') {
      return items.find((item) =>
        typeof item === 'string' ? item === response : item.label === response,
      );
    }
    return response;
  },
  async showInputBox() {
    return inputBoxResponses.shift();
  },
  async showInformationMessage(message, ...items) {
    infoMessages.push(message);
    return items[0];
  },
  async showWarningMessage(message, _optionsOrItem, ..._rest) {
    warningMessages.push(message);
    return warningResponses.length ? warningResponses.shift() : undefined;
  },
  async showErrorMessage(message, ...items) {
    errorMessages.push(message);
    return items[0];
  },
};

export const __test = {
  commandHandlers,
  fileSystemProviders,
  timelineProviders,
  sourceControls,
  statusBarItems,
  externalCommands,
  infoMessages,
  warningMessages,
  errorMessages,
  quickPickResponses,
  inputBoxResponses,
  warningResponses,
  logOutputChannels,
  storageFiles,
  storageDirectories,
  installedExtensions,
  setWorkspaceFolders(folders) {
    workspace.workspaceFolders = folders;
    workspaceFoldersChanged.fire({ added: folders ?? [], removed: [] });
  },
  installExtension({ id, packageJSON = {}, activate = async () => undefined }) {
    let activation;
    const extension = {
      id,
      packageJSON,
      extensionUri: Uri.from({ scheme: 'test-extension', authority: id, path: '/' }),
      extensionPath: `/extensions/${id}`,
      isActive: false,
      exports: undefined,
      async activate() {
        if (!activation) {
          activation = Promise.resolve()
            .then(activate)
            .then((value) => {
              extension.exports = value;
              extension.isActive = true;
              return value;
            });
        }
        return activation;
      },
    };
    installedExtensions.push(extension);
    extensionsChanged.fire(undefined);
    return extension;
  },
  removeExtension(id) {
    const index = installedExtensions.findIndex(
      (extension) => extension.id.toLowerCase() === String(id).toLowerCase(),
    );
    if (index >= 0) {
      installedExtensions.splice(index, 1);
      extensionsChanged.fire(undefined);
    }
  },
  reset(options = {}) {
    commandHandlers.clear();
    fileSystemProviders.clear();
    timelineProviders.splice(0);
    sourceControls.splice(0);
    statusBarItems.splice(0);
    externalCommands.splice(0);
    infoMessages.splice(0);
    warningMessages.splice(0);
    errorMessages.splice(0);
    quickPickResponses.splice(0);
    inputBoxResponses.splice(0);
    warningResponses.splice(0);
    if (!options.preserveStorage) {
      storageFiles.clear();
      storageDirectories.clear();
    }
    if (!options.preserveExtensions) {
      installedExtensions.splice(0);
    }
    logOutputChannels.splice(0);
    workspace.workspaceFolders = undefined;
  },
};

function stringify(value) {
  return value?.toString?.() ?? String(value ?? '');
}

function storageKey(uri) {
  return uri.toString().replace(/\/+$/u, '');
}

function hasStorageChild(key) {
  const prefix = `${key}/`;
  return (
    [...storageFiles.keys()].some((candidate) => candidate.startsWith(prefix)) ||
    [...storageDirectories].some((candidate) => candidate.startsWith(prefix))
  );
}
