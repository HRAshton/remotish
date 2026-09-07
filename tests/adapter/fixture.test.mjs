import test from 'node:test';
import { FixtureAdapter } from '@remotish/adapter-fixture';
import { runRemotishAdapterContractTests } from './contract.mjs';

runRemotishAdapterContractTests(test, () => new FixtureAdapter());
