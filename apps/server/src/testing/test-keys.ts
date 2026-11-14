// A fixed keyring for tests only. Never used outside the test suite.
import { createAesGcmBox, parseKeyring } from '../crypto/secret-box.ts';

export const TEST_ENCRYPTION_KEYS = `test1:${Buffer.alloc(32, 0x5a).toString('base64')}`;
export const TEST_ENCRYPTION_ACTIVE_KEY_ID = 'test1';

export const testSecretBox = createAesGcmBox(
  parseKeyring(TEST_ENCRYPTION_KEYS, TEST_ENCRYPTION_ACTIVE_KEY_ID),
);
