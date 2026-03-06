#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const schemaRoot = path.join(repoRoot, 'schema', 'codex-app-server-protocol');

const requiredFiles = [
  'generator.json',
  'typescript/index.ts',
  'typescript/ClientRequest.ts',
  'typescript/ServerNotification.ts',
  'typescript/ServerRequest.ts',
  'json/codex_app_server_protocol.schemas.json',
  'json/ClientRequest.json',
  'json/ServerNotification.json',
  'json/ServerRequest.json',
];

const requiredClientRequests = [
  'thread/start',
  'thread/resume',
  'thread/fork',
  'thread/archive',
  'thread/unarchive',
  'thread/name/set',
  'turn/start',
  'turn/interrupt',
  'turn/steer',
  'model/list',
];

const requiredServerNotifications = [
  'error',
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'serverRequest/resolved',
];

const requiredServerRequests = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
];

async function main() {
  const missingFiles = [];
  for (const relative of requiredFiles) {
    try {
      await readFile(path.join(schemaRoot, relative));
    } catch {
      missingFiles.push(relative);
    }
  }
  if (missingFiles.length > 0) {
    throw new Error(`Missing pinned schema artifacts: ${missingFiles.join(', ')}`);
  }

  const generator = JSON.parse(
    await readFile(path.join(schemaRoot, 'generator.json'), 'utf8'),
  );
  if (typeof generator.codex_cli_version !== 'string' || !generator.codex_cli_version.trim()) {
    throw new Error('schema/codex-app-server-protocol/generator.json is missing codex_cli_version');
  }

  const clientRequestTS = await readFile(path.join(schemaRoot, 'typescript', 'ClientRequest.ts'), 'utf8');
  const serverNotificationTS = await readFile(path.join(schemaRoot, 'typescript', 'ServerNotification.ts'), 'utf8');
  const serverRequestTS = await readFile(path.join(schemaRoot, 'typescript', 'ServerRequest.ts'), 'utf8');
  const bundledJSON = await readFile(path.join(schemaRoot, 'json', 'codex_app_server_protocol.schemas.json'), 'utf8');

  const failures = [];
  const assertSurface = (sourceName, content, items) => {
    for (const item of items) {
      if (!content.includes(`"${item}"`)) {
        failures.push(`${sourceName} is missing ${item}`);
      }
    }
  };

  assertSurface('typescript/ClientRequest.ts', clientRequestTS, requiredClientRequests);
  assertSurface('typescript/ServerNotification.ts', serverNotificationTS, requiredServerNotifications);
  assertSurface('typescript/ServerRequest.ts', serverRequestTS, requiredServerRequests);
  assertSurface('json/codex_app_server_protocol.schemas.json (client request)', bundledJSON, requiredClientRequests);
  assertSurface('json/codex_app_server_protocol.schemas.json (server notification)', bundledJSON, requiredServerNotifications);
  assertSurface('json/codex_app_server_protocol.schemas.json (server request)', bundledJSON, requiredServerRequests);

  if (failures.length > 0) {
    throw new Error(`Pinned Codex app-server schema is missing required protocol surface:\n- ${failures.join('\n- ')}`);
  }

  console.log(
    `Validated pinned Codex app-server schema (${generator.codex_cli_version}) with ${requiredClientRequests.length} client requests, ${requiredServerNotifications.length} notifications, and ${requiredServerRequests.length} server requests.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
