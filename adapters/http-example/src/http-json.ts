import {
  type Branch,
  type CommitChange,
  type CommitInfo,
  type CommitPage,
  type CommitRejectionReason,
  type CommitResult,
  type DirectoryEntry,
  RemotishError,
  type RepositoryInfo,
} from '@remotish/adapter-sdk';

const MAX_REMOTE_STRING_LENGTH = 1_000_000;
const MAX_REMOTE_PATH_LENGTH = 8_192;
const MAX_REMOTE_NAME_LENGTH = 1_024;

/** Decoder used to convert untrusted HTTP JSON into a validated protocol value. */
export type JsonDecoder<T> = (value: unknown) => T;

/** Validates repository metadata returned by the example HTTP protocol. */
export function decodeRepositoryInfo(value: unknown): RepositoryInfo {
  const record = requireRecord(value, 'repository');
  const description = optionalString(record.description, 'repository.description');
  return {
    id: requireString(record.id, 'repository.id'),
    name: requireString(record.name, 'repository.name'),
    defaultBranch: requireString(record.defaultBranch, 'repository.defaultBranch'),
    ...(description === undefined ? {} : { description }),
  };
}

/** Validates a directory listing returned by the example HTTP protocol. */
export function decodeDirectoryEntries(value: unknown): readonly DirectoryEntry[] {
  return requireArray(value, 'directory entries').map((entry, index) => {
    const record = requireRecord(entry, `directory entries[${index}]`);
    const type = requireString(record.type, `directory entries[${index}].type`);
    if (type !== 'file' && type !== 'directory') {
      throw invalidJson(`directory entries[${index}].type must be file or directory.`);
    }
    const size = optionalNumber(record.size, `directory entries[${index}].size`);
    return {
      name: requireString(record.name, `directory entries[${index}].name`, MAX_REMOTE_NAME_LENGTH),
      path: requireString(record.path, `directory entries[${index}].path`, MAX_REMOTE_PATH_LENGTH),
      type,
      ...(size === undefined ? {} : { size }),
    };
  });
}

/** Validates branch metadata returned by the example HTTP protocol. */
export function decodeBranches(value: unknown): readonly Branch[] {
  return requireArray(value, 'branches').map((entry, index) => {
    const record = requireRecord(entry, `branches[${index}]`);
    const isDefault = optionalBoolean(record.isDefault, `branches[${index}].isDefault`);
    return {
      name: requireString(record.name, `branches[${index}].name`, MAX_REMOTE_NAME_LENGTH),
      revision: requireString(record.revision, `branches[${index}].revision`),
      ...(isDefault === undefined ? {} : { isDefault }),
    };
  });
}

/** Validates one page of commit history returned by the example HTTP protocol. */
export function decodeCommitPage(value: unknown): CommitPage {
  const record = requireRecord(value, 'commit page');
  const nextCursor = optionalString(record.nextCursor, 'commit page.nextCursor');
  return {
    commits: requireArray(record.commits, 'commit page.commits').map((entry, index) =>
      decodeCommitInfo(entry, `commit page.commits[${index}]`),
    ),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Validates file changes belonging to one historical commit. */
export function decodeCommitChanges(value: unknown): readonly CommitChange[] {
  return requireArray(value, 'commit changes').map((entry, index) => {
    const record = requireRecord(entry, `commit changes[${index}]`);
    const type = requireString(record.type, `commit changes[${index}].type`);
    if (type !== 'added' && type !== 'modified' && type !== 'deleted' && type !== 'renamed') {
      throw invalidJson(`commit changes[${index}].type is unsupported.`);
    }
    const previousPath = optionalString(
      record.previousPath,
      `commit changes[${index}].previousPath`,
      MAX_REMOTE_PATH_LENGTH,
    );
    return {
      type,
      path: requireString(record.path, `commit changes[${index}].path`, MAX_REMOTE_PATH_LENGTH),
      ...(previousPath === undefined ? {} : { previousPath }),
    };
  });
}

/** Validates a commit-and-publish result returned by the example HTTP protocol. */
export function decodeCommitResult(value: unknown): CommitResult {
  const record = requireRecord(value, 'commit result');
  const status = requireString(record.status, 'commit result.status');

  if (status === 'success') {
    return {
      status,
      revision: requireString(record.revision, 'commit result.revision'),
      commit: decodeCommitInfo(record.commit, 'commit result.commit'),
    };
  }

  if (status !== 'rejected') {
    throw invalidJson('commit result.status must be success or rejected.');
  }

  const reason = decodeRejectionReason(record.reason);
  const remoteRevision = optionalString(record.remoteRevision, 'commit result.remoteRevision');
  const message = optionalString(record.message, 'commit result.message');
  return {
    status,
    reason,
    ...(remoteRevision === undefined ? {} : { remoteRevision }),
    ...(message === undefined ? {} : { message }),
  };
}

/** Validates one branch response from branch creation. */
export function decodeBranch(value: unknown): Branch {
  const record = requireRecord(value, 'branch');
  const isDefault = optionalBoolean(record.isDefault, 'branch.isDefault');
  return {
    name: requireString(record.name, 'branch.name', MAX_REMOTE_NAME_LENGTH),
    revision: requireString(record.revision, 'branch.revision'),
    ...(isDefault === undefined ? {} : { isDefault }),
  };
}

/** Narrows unknown JSON to a plain record for error and payload validation. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeCommitInfo(value: unknown, context: string): CommitInfo {
  const record = requireRecord(value, context);
  const parents = requireArray(record.parents, `${context}.parents`).map((parent, index) =>
    requireString(parent, `${context}.parents[${index}]`),
  );
  const author = decodeAuthor(record.author, `${context}.author`);
  const authoredAt = optionalString(record.authoredAt, `${context}.authoredAt`);
  return {
    revision: requireString(record.revision, `${context}.revision`),
    parents,
    message: requireString(record.message, `${context}.message`),
    ...(author === undefined ? {} : { author }),
    ...(authoredAt === undefined ? {} : { authoredAt }),
  };
}

function decodeAuthor(value: unknown, context: string): CommitInfo['author'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, context);
  const email = optionalString(record.email, `${context}.email`);
  return {
    name: requireString(record.name, `${context}.name`),
    ...(email === undefined ? {} : { email }),
  };
}

function decodeRejectionReason(value: unknown): CommitRejectionReason {
  const reason = requireString(value, 'commit result.reason');
  if (reason === 'REMOTE_CHANGED' || reason === 'FORBIDDEN' || reason === 'UNSUPPORTED') {
    return reason;
  }
  throw invalidJson(`unsupported commit rejection reason: ${reason}.`);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidJson(`${context} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidJson(`${context} must be an array.`);
  }
  return value;
}

function requireString(
  value: unknown,
  context: string,
  maxLength = MAX_REMOTE_STRING_LENGTH,
): string {
  if (typeof value !== 'string') {
    throw invalidJson(`${context} must be a string.`);
  }
  if (value.length > maxLength) {
    throw invalidJson(`${context} exceeds the ${maxLength}-character limit.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  context: string,
  maxLength = MAX_REMOTE_STRING_LENGTH,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, context, maxLength);
}

function optionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidJson(`${context} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(value: unknown, context: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidJson(`${context} must be a boolean.`);
  }
  return value;
}

function invalidJson(message: string): RemotishError {
  return new RemotishError('UNKNOWN', `Invalid HTTP adapter response: ${message}`);
}
