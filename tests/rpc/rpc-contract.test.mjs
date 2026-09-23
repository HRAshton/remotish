import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { decodeRpcRequest, encodeRpcSuccess, RpcAdapter } from '@remotish/adapter-rpc';
import { runRemotishAdapterContractTests } from '../adapter/contract.mjs';

runRemotishAdapterContractTests(test, () => {
  const backend = new FixtureAdapter();
  const transport = {
    async request(raw, options) {
      const { operation, payload } = decodeRpcRequest(structuredClone(raw));
      let result;
      switch (operation) {
        case 'getRepository':
          result = await backend.getRepository(options);
          break;
        case 'readDirectory':
          result = await backend.readDirectory(payload.revision, payload.path, options);
          break;
        case 'readFile':
          result = await backend.readFile(payload.revision, payload.path, options);
          break;
        case 'getBranches':
          result = await backend.getBranches(options);
          break;
        case 'getCommits':
          result = await backend.getCommits(payload, options);
          break;
        case 'getCommitChanges':
          result = await backend.getCommitChanges(payload.revision, options);
          break;
        case 'commit':
          result = await backend.commit(payload, options);
          break;
        case 'createBranch':
          result = await backend.createBranch(payload.name, payload.revision, options);
          break;
        case 'deleteBranch':
          await backend.deleteBranch(payload.name, options);
          result = null;
          break;
      }
      return structuredClone(encodeRpcSuccess(operation, result));
    },
  };
  const adapter = new RpcAdapter(transport, { version: 1, capabilities: backend.capabilities });
  adapter.getBranchHead = (name) => backend.getBranchHead(name);
  adapter.moveBranchHead = (name, revision) => backend.moveBranchHead(name, revision);
  return adapter;
});
