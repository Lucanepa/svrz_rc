// The installed app's web bundle (dist-native), on any OS. It used to be an npm
// script with a `VITE_NATIVE=1 vite build` prefix, which only a POSIX shell
// understands: Windows runs npm scripts in cmd.exe, so the first release build
// on a Windows runner failed before compiling anything (10.10.2026). Variables
// already in the environment win over .env files in Vite, the same as the
// prefix did.
import { build } from 'vite';

process.env.VITE_NATIVE = '1';
process.env.VITE_API_BASE_URL ||= 'https://svrz-rc-api.openvolley.app';

await build({ build: { outDir: 'dist-native', emptyOutDir: true } });
