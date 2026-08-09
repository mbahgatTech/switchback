/**
 * Proves the Vercel alarm channel end to end: posts one trace to Application Insights and reports
 * whether the collector accepted it. Reads `APPLICATIONINSIGHTS_CONNECTION_STRING`, prints none of it.
 */
import { appInsightsTarget, createTraceSink, trackUrl } from '@switchback/db/app-insights';

async function main(): Promise<void> {
  const target = appInsightsTarget();
  if (!target) {
    console.error(
      'APPLICATIONINSIGHTS_CONNECTION_STRING is absent or carries no ingestion endpoint.',
    );
    process.exitCode = 1;
    return;
  }

  const marker = process.argv[2] ?? 'switchback-db-token-alarm-probe';
  const role = process.argv[3] ?? 'switchback-web';
  const stamp = new Date().toISOString();
  const message = `${marker} probe at ${stamp}`;

  console.log(`endpoint ${trackUrl(target)}`);
  console.log(`role     ${role}`);
  console.log(`message  ${message}`);

  await createTraceSink(target)({
    message,
    severity: 'error',
    role,
    properties: { probe: 'true', at: stamp },
  });

  console.log('\nAccepted. It reaches AppTraces within about two minutes:');
  console.log(
    `  az monitor log-analytics query -w <workspace-guid> --analytics-query ` +
      `"AppTraces | where Message has '${marker}' | project TimeGenerated, AppRoleName, Message" -o json`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
