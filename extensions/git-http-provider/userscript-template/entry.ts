import { startGitHttpUserscript } from '../src/userscript-runtime.js';

// Copy this file and metadata.txt into ignored local/ before configuring customer values.
const codeOrigin = 'https://code.example.invalid';
const gitUrl = 'https://git.example.invalid/scm/PRJ/repo.git';
const redirectProbeUrl = 'https://code.example.invalid/remotish-git-redirect-probe';
const pairingKey = 'REPLACE_WITH_YOUR_OWN_43_CHARACTER_BASE64URL_KEY';

startGitHttpUserscript({ codeOrigin, gitUrl, redirectProbeUrl, pairingKey }).catch(() => {
  console.error(
    'Git HTTP userscript did not start. Check the local redirect probe and bridge configuration.',
  );
});
