import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/config.ts';

try {
  const config = validateConfig(JSON.parse(await readFile(new URL('../config/forms.json', import.meta.url), 'utf8')));
  const enabled = Object.values(config.forms).filter(form => form.enabled).length;
  console.log('Configuration valid: ' + Object.keys(config.forms).length + ' forms, ' + enabled + ' enabled.');
  if (!enabled) console.log('Forms are disabled until you configure your origins, addresses, and Turnstile widget.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration invalid.');
  process.exitCode = 1;
}
