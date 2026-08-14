import * as vscode from 'vscode';
import { registerBranchCommands } from './branches/commands.js';
import { BranchUiManager } from './branches/manager.js';
import { registerScmCommands } from './commands/scm-commands.js';
import { RepositoryFileSystem } from './filesystem/file-system.js';
import { RemotishFileSystemProvider } from './filesystem/provider.js';
import { REVISION_SCHEME, WORKING_SCHEME } from './filesystem/uri.js';
import { ScmManager } from './scm/manager.js';
import { WorkspaceRegistry } from './workspaces/workspace-registry.js';

/** Coordinates VFS, SCM, branch UX, persistence, and workspace registrations for VS Code. */
export class RemotishVsCodeHost implements vscode.Disposable {
  readonly registry = new WorkspaceRegistry();
  readonly scm: ScmManager;
  readonly branches: BranchUiManager;
  private readonly disposables: vscode.Disposable[];

  constructor() {
    const logger = vscode.window.createOutputChannel('Remotish', { log: true });
    const fileSystem = new RepositoryFileSystem(this.registry);
    const workingProvider = new RemotishFileSystemProvider(this.registry, fileSystem, 'working');
    const revisionProvider = new RemotishFileSystemProvider(this.registry, fileSystem, 'revision');
    this.scm = new ScmManager(this.registry);
    this.branches = new BranchUiManager(this.registry);

    this.disposables = [
      logger,
      workingProvider,
      revisionProvider,
      this.scm,
      this.branches,
      vscode.workspace.registerFileSystemProvider(WORKING_SCHEME, workingProvider, {
        isCaseSensitive: true,
      }),
      vscode.workspace.registerFileSystemProvider(REVISION_SCHEME, revisionProvider, {
        isCaseSensitive: true,
        isReadonly: true,
      }),
      registerScmCommands(this.registry, this.scm, logger),
      registerBranchCommands(this.registry, logger),
    ];
  }

  dispose(): void {
    for (const disposable of [...this.disposables].reverse()) {
      disposable.dispose();
    }
  }
}
