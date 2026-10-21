import { readReviewEnv } from "@/lib/env";
import {
  createCachedTokenProvider,
  createGraphCredential,
  type TokenProvider,
} from "../graph/credential";
import { ReviewError, toReviewError } from "./errors";

/**
 * How the platform proves it is the platform - to the review app registration.
 *
 * Nothing new is decided here. `createGraphCredential` already holds the two
 * rules that matter - a client secret on developer machines, the managed
 * identity's token as a client assertion in production, and a refusal to boot
 * production with a secret set - and it takes its client id as a parameter.
 * So the review app is the same factory with a different id, and a
 * prohibition-7 fix made to the mail credential is made to this one too.
 *
 * What is different is only the not-configured case: it is reported in the
 * review module's vocabulary, so the tab can say so without reaching Graph.
 */
let memoisedProvider: TokenProvider | null = null;

export function reviewTokenProvider(): TokenProvider {
  if (memoisedProvider !== null) return memoisedProvider;

  const reviewEnv = readReviewEnv();
  if (!reviewEnv.present) {
    throw new ReviewError("not_configured", {
      detail: `Missing review configuration: ${reviewEnv.missing.join(", ")}`,
    });
  }

  const { clientId, tenantId, clientSecret, managedIdentityClientId } = reviewEnv.values;

  let credential;
  try {
    credential = createGraphCredential({
      clientId,
      tenantId,
      clientSecret,
      managedIdentityClientId,
    });
  } catch (error) {
    // The factory speaks in MailError - "no secret outside production", "a
    // secret in production". Both are this module's not_configured.
    throw toReviewError(error, "reviewTokenProvider");
  }

  memoisedProvider = createCachedTokenProvider(credential);
  return memoisedProvider;
}
