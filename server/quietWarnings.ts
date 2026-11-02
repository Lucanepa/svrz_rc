// Node's notices about experimental features, kept out of the error alerts.
//
// Node prints an ExperimentalWarning the first time a process touches an
// experimental feature, and prints it through console.error — which
// captureConsole() files as an error, and the alert mailer then mails. The
// passkey library's certificate code (@peculiar/x509, under
// @simplewebauthn/server) probes two experimental Web Crypto features
// (SubtleCrypto.supports, ML-DSA) on the first ceremony after every restart,
// so the first passkey after each deploy mailed "2 errors in 2 kinds"
// (02.11.2026). Those two are expected and harmless. Every other warning is
// still printed by Node's own handler, exactly as before.

type WarningSource = Pick<NodeJS.Process, 'listeners' | 'removeAllListeners' | 'on'>;

/** The notices known to be harmless: Node's ExperimentalWarning about the
 *  Web Crypto API, and nothing else. */
export function isExpectedWarning(warning: { name?: string; message?: string } | null | undefined): boolean {
  return warning?.name === 'ExperimentalWarning' && /Web Crypto API/.test(String(warning?.message ?? ''));
}

/** Puts a filter in front of the process's warning handlers (Node's printer
 *  among them): the expected notices stop there, the rest go on to them. */
export function quietExpectedWarnings(source: WarningSource = process): void {
  const handlers = source.listeners('warning') as Array<(warning: Error) => void>;
  source.removeAllListeners('warning');
  source.on('warning', (warning: Error) => {
    if (isExpectedWarning(warning)) return;
    for (const handler of handlers) handler(warning);
  });
}
