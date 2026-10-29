/**
 * Sends the sign-in link. RESEND_API_KEY and MAIL_FROM (an address on a domain verified
 * with Resend, such as "Blockfisher <hello@blockfisher.co.uk>") send it by email. Without
 * them the link is only written to the server log, which is enough for local testing.
 */
export interface Mailer {
  kind: string;
  sendSignIn(to: string, link: string): Promise<void>;
}

export function mailerFrom(env: { RESEND_API_KEY?: string; MAIL_FROM?: string }): Mailer {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!key || !from) {
    return {
      kind: 'log',
      async sendSignIn(to, link) {
        console.log(`sign-in link for ${to} (no RESEND_API_KEY, so not emailed): ${link}`);
      },
    };
  }
  return {
    kind: 'resend',
    async sendSignIn(to, link) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to,
          subject: 'Sign in to Blockfisher',
          text: `Open this link to sign in to Blockfisher on this browser. It works once, for 30 minutes.\n\n${link}\n\nIf you didn't ask to sign in, you can ignore this email.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Resend answered ${response.status}`);
    },
  };
}
