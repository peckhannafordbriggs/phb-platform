/**
 * Fixed values shared by tests/setup.ts and the tests themselves, so a test can
 * mint claims that match the tenant the code under test is configured with.
 */
export const TEST_TENANT_ID = "11111111-2222-3333-4444-555555555555";
export const TEST_ALLOWED_DOMAIN = "phb1899.com";

/**
 * The mailbox the mail tests are configured with. `.invalid` is reserved by
 * RFC 2606 and resolves nowhere, so a request that escapes interception fails
 * instead of touching the live change-order mailbox.
 */
export const TEST_MAILBOX = "zztest-mailbox@example.invalid";

/** Fake, and GUID-shaped so the configuration check accepts them. */
export const TEST_GRAPH_CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const TEST_GRAPH_TENANT_ID = "99999999-8888-4777-9666-555555555555";
