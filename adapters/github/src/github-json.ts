import { RemotishError } from '@remotish/adapter-sdk';
import type {
  GitHubBlobResponse,
  GitHubBranchResponse,
  GitHubCommitDetailResponse,
  GitHubCommitListResponse,
  GitHubGitCommitResponse,
  GitHubObjectShaResponse,
  GitHubRepositoryResponse,
  GitHubShaResponse,
  GitHubTreeEntry,
  GitHubTreeResponse,
} from './types.js';

const MAX_REMOTE_STRING_LENGTH = 1_000_000;
const MAX_REMOTE_PATH_LENGTH = 8_192;
const MAX_REMOTE_NAME_LENGTH = 1_024;
const MAX_BLOB_BASE64_LENGTH = 96 * 1024 * 1024;

/** Decoder used to turn untrusted JSON into a validated GitHub response shape. */
export type JsonDecoder<T> = (value: unknown) => T;

/** Validates the repository fields Remotish relies on. */
export function decodeRepository(value: unknown): GitHubRepositoryResponse {
  const record = requireRecord(value, 'repository');
  return {
    id: requireNumber(record.id, 'repository.id'),
    node_id: requireString(record.node_id, 'repository.node_id'),
    name: requireString(record.name, 'repository.name', MAX_REMOTE_NAME_LENGTH),
    full_name: requireString(record.full_name, 'repository.full_name'),
    description: requireNullableString(record.description, 'repository.description'),
    default_branch: requireString(
      record.default_branch,
      'repository.default_branch',
      MAX_REMOTE_NAME_LENGTH,
    ),
  };
}

/** Validates one page from GitHub's branch listing endpoint. */
export function decodeBranches(value: unknown): readonly GitHubBranchResponse[] {
  return requireArray(value, 'branches').map((entry, index) => {
    const record = requireRecord(entry, `branches[${index}]`);
    const commit = requireRecord(record.commit, `branches[${index}].commit`);
    return {
      name: requireString(record.name, `branches[${index}].name`, MAX_REMOTE_NAME_LENGTH),
      commit: { sha: requireString(commit.sha, `branches[${index}].commit.sha`) },
    };
  });
}

/** Validates one page from GitHub's commit listing endpoint. */
export function decodeCommitList(value: unknown): readonly GitHubCommitListResponse[] {
  return requireArray(value, 'commits').map((entry, index) =>
    decodeCommitListEntry(entry, `commits[${index}]`),
  );
}

/** Validates a GitHub commit-detail payload, including optional changed files. */
export function decodeCommitDetail(value: unknown): GitHubCommitDetailResponse {
  const record = requireRecord(value, 'commit');
  const base = decodeCommitListEntry(record, 'commit');
  const files = record.files;

  if (files === undefined) {
    return base;
  }

  return {
    ...base,
    files: requireArray(files, 'commit.files').map((entry, index) => {
      const file = requireRecord(entry, `commit.files[${index}]`);
      const previousFilename = optionalString(
        file.previous_filename,
        `commit.files[${index}].previous_filename`,
        MAX_REMOTE_PATH_LENGTH,
      );
      return {
        filename: requireString(
          file.filename,
          `commit.files[${index}].filename`,
          MAX_REMOTE_PATH_LENGTH,
        ),
        status: requireString(file.status, `commit.files[${index}].status`),
        ...(previousFilename === undefined ? {} : { previous_filename: previousFilename }),
      };
    }),
  };
}

/** Validates a Git Data commit payload. */
export function decodeGitCommit(value: unknown): GitHubGitCommitResponse {
  const record = requireRecord(value, 'git commit');
  const tree = requireRecord(record.tree, 'git commit.tree');
  const parents = requireArray(record.parents, 'git commit.parents').map((entry, index) => {
    const parent = requireRecord(entry, `git commit.parents[${index}]`);
    return { sha: requireString(parent.sha, `git commit.parents[${index}].sha`) };
  });
  const author = decodeAuthor(record.author, 'git commit.author');

  return {
    sha: requireString(record.sha, 'git commit.sha'),
    message: requireString(record.message, 'git commit.message'),
    tree: { sha: requireString(tree.sha, 'git commit.tree.sha') },
    parents,
    ...(author === undefined ? {} : { author }),
  };
}

/** Validates a Git Data tree payload. */
export function decodeTree(value: unknown): GitHubTreeResponse {
  const record = requireRecord(value, 'tree');
  const truncated = optionalBoolean(record.truncated, 'tree.truncated');
  return {
    sha: requireString(record.sha, 'tree.sha'),
    tree: requireArray(record.tree, 'tree.tree').map((entry, index) =>
      decodeTreeEntry(entry, `tree.tree[${index}]`),
    ),
    ...(truncated === undefined ? {} : { truncated }),
  };
}

/** Validates a Git Data blob payload used for immutable file reads. */
export function decodeBlob(value: unknown): GitHubBlobResponse {
  const record = requireRecord(value, 'blob');
  return {
    content: requireString(record.content, 'blob.content', MAX_BLOB_BASE64_LENGTH),
    encoding: requireString(record.encoding, 'blob.encoding'),
  };
}

/** Validates the common GitHub response shape containing a created object SHA. */
export function decodeSha(value: unknown): GitHubShaResponse {
  const record = requireRecord(value, 'GitHub object');
  return { sha: requireString(record.sha, 'GitHub object.sha') };
}

/** Validates a Git reference response and its target SHA. */
export function decodeObjectSha(value: unknown): GitHubObjectShaResponse {
  const record = requireRecord(value, 'Git reference');
  const object = requireRecord(record.object, 'Git reference.object');
  return { object: { sha: requireString(object.sha, 'Git reference.object.sha') } };
}

/** Narrows unknown JSON to a record without relying on unchecked assertions. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeCommitListEntry(value: unknown, context: string): GitHubCommitListResponse {
  const record = requireRecord(value, context);
  const commit = requireRecord(record.commit, `${context}.commit`);
  const parents = requireArray(record.parents, `${context}.parents`).map((entry, index) => {
    const parent = requireRecord(entry, `${context}.parents[${index}]`);
    return { sha: requireString(parent.sha, `${context}.parents[${index}].sha`) };
  });
  const author = decodeAuthor(commit.author, `${context}.commit.author`);

  return {
    sha: requireString(record.sha, `${context}.sha`),
    parents,
    commit: {
      message: requireString(commit.message, `${context}.commit.message`),
      ...(author === undefined ? {} : { author }),
    },
  };
}

function decodeAuthor(
  value: unknown,
  context: string,
): GitHubGitCommitResponse['author'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const record = requireRecord(value, context);
  const name = optionalString(record.name, `${context}.name`);
  const email = optionalString(record.email, `${context}.email`);
  const date = optionalString(record.date, `${context}.date`);

  return {
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(date === undefined ? {} : { date }),
  };
}

function decodeTreeEntry(value: unknown, context: string): GitHubTreeEntry {
  const record = requireRecord(value, context);
  const type = requireString(record.type, `${context}.type`);
  if (type !== 'blob' && type !== 'tree' && type !== 'commit') {
    throw invalidJson(`${context}.type must be blob, tree, or commit.`);
  }
  const size = optionalNumber(record.size, `${context}.size`);

  return {
    path: requireString(record.path, `${context}.path`, MAX_REMOTE_PATH_LENGTH),
    mode: requireString(record.mode, `${context}.mode`),
    type,
    sha: requireString(record.sha, `${context}.sha`),
    ...(size === undefined ? {} : { size }),
  };
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

function requireNullableString(value: unknown, context: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, context);
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidJson(`${context} must be a finite number.`);
  }
  return value;
}

function optionalNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNumber(value, context);
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
  return new RemotishError('UNKNOWN', `Invalid GitHub response: ${message}`);
}
