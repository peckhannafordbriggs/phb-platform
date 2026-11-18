import { GraphClientError, ResponseType, type Client } from "@microsoft/microsoft-graph-client";
import {
  ManagedIdentityAssertionError,
  createManagedIdentityAssertionProvider,
  type AssertionProvider,
} from "@/lib/azure/managed-identity-assertion";
import { createAppCredential, createCachedTokenProvider } from "@/lib/mail/credential";
import { createSharedGraphClient, type TokenProvider } from "@/lib/mail/graph-client";
import { SIMPLE_UPLOAD_MAX_BYTES, safeAttachmentName } from "@/lib/modules/change-orders/mail/attachments";
import { SEND_DISABLED_MESSAGE } from "../delivery-words";
import { mailNotConfiguredReason, type BasMailEnv } from "../job-env";
import { isExternalAddress } from "../recipients";

/**
 * The BAS report sender (Reports, Phase 4, the email half - 2026-11-17): the
 * ONE place in the platform that sends a message on its own, and only from
 * the Reports worker job. The web app never imports this file - a Resend or
 * a Send to me writes a delivery row and the worker sends it
 * (tests/bas-reports-email.test.ts walks the imports).
 *
 * CLAUDE.md prohibition 1 - never auto-send - is the change-order system's
 * safety model and is untouched: this is a different mailbox
 * (controlls@phb1899.com), a different app registration
 * (phb-platform-bas-mail, Request 7, Mail.Send fenced by its own Exchange
 * ApplicationAccessPolicy), and a decision the plan records (§A Sender, §D5).
 * Nothing here can reach changeorder@: the mailbox is this module's
 * configuration, and the app's policy refuses every other mailbox at Exchange.
 *
 * Three refusals, in order, all before any network call:
 *
 *   1. the SEND GATE, BAS_REPORTS_ALLOW_SEND, mirroring PHB_ALLOW_SEND -
 *      exactly "true" or nothing sends. Not even a token is fetched;
 *   2. outside production, a recipient that is not a company address - a
 *      developer with the gate open locally sends to colleagues, never to a
 *      contractor (CLAUDE.md: test sends go to the operator's own address);
 *   3. the configuration - the app's ids, and on a developer machine its
 *      secret; in production a secret present is refused, as the Change
 *      Orders credential refuses one.
 *
 * The credential and the client are the Change Orders ones, shared since the
 * same day as lib/mail/credential.ts and lib/mail/graph-client.ts: the
 * ImmutableId header, the one throttle retry, the token cache, the managed
 * identity's assertion. The attachment size rule is Change Orders' too:
 * SIMPLE_UPLOAD_MAX_BYTES, Graph's own line for an attachment carried inside
 * one request.
 *
 * WHY sendMail AND NOT A DRAFT. The app holds Mail.Send only (Request 7):
 * it may send as the mailbox and may not read or write its items, so a
 * draft-then-send is not open to it. sendMail answers 202 with no body - no
 * message id - so a delivery keeps Graph's request-id, and the message
 * carries X-PHB-Report-Delivery: <delivery id> for a message trace to find.
 */

export const REPORT_DELIVERY_HEADER = "X-PHB-Report-Delivery";
/** Graph's simple-upload line, the Change Orders rule: a larger PDF is not attached and the body links to the run instead. */
export const EMAIL_ATTACHMENT_MAX_BYTES = SIMPLE_UPLOAD_MAX_BYTES;

export type ReportMailErrorKind = "send_disabled" | "refused_address" | "not_configured" | "auth_failed" | "graph" | "network" | "run_unavailable";

export class ReportMailError extends Error {
  constructor(
    readonly kind: ReportMailErrorKind,
    message: string,
    /** Whether another attempt could succeed without a person changing something first. */
    readonly retryable: boolean,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ReportMailError";
  }
}

export const isReportMailError = (error: unknown): error is ReportMailError => error instanceof ReportMailError;

export { SEND_DISABLED_MESSAGE };

export interface ReportMail {
  /** One address. One message per recipient, never a list. */
  to: string;
  subject: string;
  html: string;
  attachment: { name: string; bytes: Uint8Array } | null;
  /** Written into X-PHB-Report-Delivery. */
  deliveryId: string;
}

export interface SentReportMail {
  /** Graph's request-id for the accepted call, or null when it sent none. */
  requestId: string | null;
}

export interface ReportMailer {
  readonly mailbox: string;
  readonly allowSend: boolean;
  send(mail: ReportMail): Promise<SentReportMail>;
}

export interface ReportMailerDeps {
  /** The HTTP boundary. Tests fake Graph here and nothing above it. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the credential entirely (a test that is not about the credential). */
  tokenProvider?: TokenProvider;
  /** The production half's assertion, for a test of that path. */
  assertion?: (managedIdentityClientId: string | null) => AssertionProvider;
}

/** Status, code and request id, never a body: the same fields the Change Orders error mapping keeps. */
function describeGraphFailure(status: number, code: string | null, requestId: string | null): string {
  const hint =
    status === 403
      ? " (the app's ApplicationAccessPolicy or its Mail.Send consent - runbook: A report email did not arrive)"
      : status === 404
        ? " (the mailbox does not exist, or the app cannot see it)"
        : status === 401
          ? " (the token was refused)"
          : "";
  return `Graph refused the send: status=${status} code=${code ?? "none"}${requestId !== null ? ` requestId=${requestId}` : ""}${hint}.`;
}

export function createReportMailer(mail: BasMailEnv, deps: ReportMailerDeps = {}): ReportMailer {
  let client: Client | null = null;

  function graph(): Client {
    if (client !== null) return client;
    const reason = mailNotConfiguredReason(mail);
    if (deps.tokenProvider === undefined && reason !== null) {
      throw new ReportMailError("not_configured", reason, false);
    }
    const tokenProvider =
      deps.tokenProvider ??
      createCachedTokenProvider(
        createAppCredential(
          { clientId: mail.clientId!, tenantId: mail.tenantId!, clientSecret: mail.clientSecret, managedIdentityClientId: mail.managedIdentityClientId },
          {
            production: mail.production,
            assertion: deps.assertion ?? ((managedIdentityClientId) => createManagedIdentityAssertionProvider({ managedIdentityClientId })),
            vocabulary: {
              secretInProduction: () => new ReportMailError("not_configured", mailNotConfiguredReason(mail) ?? "A client secret is set in production.", false),
              secretMissing: () => new ReportMailError("not_configured", mailNotConfiguredReason(mail) ?? "No client secret outside production.", false),
              assertionFailed: (error: ManagedIdentityAssertionError) => new ReportMailError("auth_failed", error.message, true),
            },
          },
        ),
        {
          // The cause's own message carries Entra's AADSTS code, which is what
          // tells a person whether the federated credential or the consent is
          // missing. No token or secret is ever in it.
          tokenRefused: (detail, cause) =>
            new ReportMailError(
              "auth_failed",
              `${detail}${cause instanceof Error && cause.message ? ` - ${cause.message.replace(/\s+/g, " ").slice(0, 400)}` : ""}`,
              true,
            ),
        },
      );
    client = createSharedGraphClient({
      tokenProvider,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      passThrough: isReportMailError,
    });
    return client;
  }

  return {
    mailbox: mail.mailbox,
    allowSend: mail.allowSend,

    async send(message: ReportMail): Promise<SentReportMail> {
      // 1. The gate, before anything else - no token, no request.
      if (!mail.allowSend) throw new ReportMailError("send_disabled", SEND_DISABLED_MESSAGE, false);

      // 2. Outside production, company addresses only.
      if (!mail.production && isExternalAddress(message.to)) {
        throw new ReportMailError(
          "refused_address",
          `Not sent: outside production a report email goes only to @phb1899.com addresses, and ${message.to} is not one.`,
          false,
        );
      }

      if (message.attachment !== null && message.attachment.bytes.length > EMAIL_ATTACHMENT_MAX_BYTES) {
        // The caller decides to attach; this is the backstop for a caller that did not check.
        throw new ReportMailError("graph", `The attachment is ${message.attachment.bytes.length} bytes, over the ${EMAIL_ATTACHMENT_MAX_BYTES}-byte limit.`, false);
      }

      // 3. The configuration, then one call.
      const body = {
        message: {
          subject: message.subject,
          body: { contentType: "HTML", content: message.html },
          toRecipients: [{ emailAddress: { address: message.to } }],
          internetMessageHeaders: [{ name: REPORT_DELIVERY_HEADER, value: message.deliveryId }],
          ...(message.attachment === null
            ? {}
            : {
                attachments: [
                  {
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    name: safeAttachmentName(message.attachment.name),
                    contentType: "application/pdf",
                    contentBytes: Buffer.from(message.attachment.bytes).toString("base64"),
                  },
                ],
              }),
        },
        saveToSentItems: true,
      };

      let response: Response;
      try {
        response = (await graph()
          .api(`/users/${encodeURIComponent(mail.mailbox)}/sendMail`)
          .responseType(ResponseType.RAW)
          .post(body)) as Response;
      } catch (error) {
        if (error instanceof ReportMailError) throw error;
        if (error instanceof GraphClientError && error.customError instanceof ReportMailError) throw error.customError;
        throw new ReportMailError(
          "network",
          `The send never got an answer from Graph: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 500),
          true,
        );
      }

      const headerRequestId = response.headers.get("request-id");
      if (response.status === 202 || response.ok) return { requestId: headerRequestId };

      // The code, and the request id when the header lacks it - Graph puts it
      // in the error body's innerError as well. Nothing else is read from the body.
      let code: string | null = null;
      let requestId = headerRequestId;
      try {
        const parsed = (await response.json()) as { error?: { code?: unknown; innerError?: { "request-id"?: unknown } } };
        code = typeof parsed.error?.code === "string" ? parsed.error.code : null;
        const inner = parsed.error?.innerError?.["request-id"];
        if (requestId === null && typeof inner === "string") requestId = inner;
      } catch {
        code = null;
      }
      throw new ReportMailError("graph", describeGraphFailure(response.status, code, requestId), true, requestId);
    },
  };
}
