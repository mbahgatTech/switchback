/**
 * Prints an Apple client secret.
 *
 * The server mints these itself on every sign-in, so nothing in Switchback needs this
 * script. It exists for the times you have to talk to Apple without the server in the
 * loop: pasting a secret into a curl to see what `invalid_client` actually means, or
 * checking that a freshly downloaded `.p8` and Key ID agree with each other before
 * wondering why sign-in fails.
 *
 *   npm run apple:secret --workspace=@switchback/web
 */
import { decodeJwt } from 'jose';
import { appleClientSecret } from '../src/auth-apple';

async function main(): Promise<void> {
  const secret = await appleClientSecret();
  const claims = decodeJwt(secret);

  console.log(secret);
  console.log();
  console.log('Claims:');
  console.log(`  iss (team id)     ${String(claims.iss)}`);
  console.log(`  sub (services id) ${String(claims.sub)}`);
  console.log(`  aud               ${String(claims.aud)}`);
  console.log(`  exp               ${new Date(Number(claims.exp) * 1000).toISOString()} (1 hour)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
