import { z } from "zod";

/**
 * Draft edit bodies.
 *
 * Strict objects, like the profile schemas: an unknown key is rejected rather
 * than stripped. What is NOT declared here matters as much as what is -
 * attachments, isDraft, folder, flags and anything else Graph would accept on a
 * PATCH cannot reach the service, because the service builds its payload from
 * these fields alone.
 */

const address = z.strictObject({
  name: z.string().trim().max(200).nullable().default(null),
  address: z.email(),
});

/** Exchange's own limits are higher; these are sane bounds, not a policy. */
const recipients = z.array(address).max(100);

export const draftPatchSchema = z
  .strictObject({
    // A subject may legitimately be emptied, so "" is allowed and undefined
    // means "do not touch it". Nothing here parses or normalizes the
    // `[CCHMC RFI 229]` tag - it is written back exactly as supplied.
    subject: z.string().max(500).optional(),
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    body: z
      .strictObject({
        content: z.string().max(5_000_000),
        format: z.enum(["html", "text"]),
      })
      .optional(),
    /**
     * The version the editor last saw. Sent so the service can refuse a save
     * that would silently overwrite an edit made in Outlook.
     */
    expectedChangeKey: z.string().max(500).nullish(),
  })
  .refine(
    (v) =>
      v.subject !== undefined ||
      v.to !== undefined ||
      v.cc !== undefined ||
      v.bcc !== undefined ||
      v.body !== undefined,
    { message: "Provide at least one field to change." },
  );

export type DraftPatchInput = z.infer<typeof draftPatchSchema>;

/**
 * The send body.
 *
 * Deliberately carries no recipients, no subject and no content. A send posts to
 * an existing draft and takes nothing from the caller - that is what makes it
 * impossible for this route to become `sendMail` with a copied body, which would
 * drop the attachments, the subject tag and the threading.
 *
 * `expectedChangeKey` is required, not optional: it is how the route proves the
 * draft on the server is the one the human read before clicking send.
 */
export const draftSendSchema = z.strictObject({
  expectedChangeKey: z.string().max(500).nullable(),
});
