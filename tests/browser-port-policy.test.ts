import { expect, it } from 'vitest';
import { validateUrl } from '../src/browser/security.js';
it('rejects protocol and port mismatches before making an upstream connection', async () => {
  for (const url of ['http://example.com:443', 'https://example.com:80'])
    await expect(validateUrl(url)).rejects.toThrow('standard web ports');
});
