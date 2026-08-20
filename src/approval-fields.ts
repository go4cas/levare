// The single source of truth for every frontmatter field an approval writes beyond the universal
// stamp (`status`/`approved_by`/`approved_commit`, stamped by every `approve` regardless of kind).
//
// Both sides of the §4 immutability boundary derive from THIS object, not from independently
// maintained copies:
//   - the writer (board/gateops.ts) can only add a kind-specific field through `writeApprovalField`
//     below, whose type parameter rejects any (kind, field) pair not listed in `KIND_APPROVAL_FIELDS`
//     — a compile error, caught before the code ships, not a validate.ts surprise discovered against
//     a real studio months later (exactly how `merge_result` slipped through the first time).
//   - the checker (validate.ts#stripApprovalStamp) excludes exactly the fields `approvalExemptFields`
//     returns from the post-approval content comparison, by reading this same object.
// A field that's written but never added here can't happen: `writeApprovalField` won't compile for
// it. A field that's added here but never actually written by any approval path is harmless (an
// unused exemption, not a silent gap) — the asymmetry is deliberate, since "exempt but unwritten" is
// safe while "written but not exempt" is the exact bug this registry exists to make impossible.
import { upsertFrontmatterMap } from "./gates.ts";

/** Written by `stampApproval` on every `approve`, regardless of artifact kind. */
export const APPROVAL_STAMP_FIELDS = ["status", "approved_by", "approved_commit"] as const;

/** Additional frontmatter MAP fields a specific `kind`'s own approval path writes, on top of the
 *  stamp — keyed by kind so a field registered for `merge` doesn't accidentally exempt it for
 *  every other kind too. */
export const KIND_APPROVAL_FIELDS = {
  merge: ["merge_result"],
  proposal: ["execution"],
} as const satisfies Record<string, readonly string[]>;

export type ApprovalKind = keyof typeof KIND_APPROVAL_FIELDS;
type ApprovalField<K extends ApprovalKind> = (typeof KIND_APPROVAL_FIELDS)[K][number];

/** Every frontmatter field an approval of an artifact of `kind` may legitimately have written —
 *  the universal stamp plus whatever that kind's own approval path additionally writes. `kind`
 *  is read from on-disk data (validate.ts), so it's a plain string here, not `ApprovalKind` — an
 *  unrecognized kind simply gets no extra exemptions, same as any kind that has none today. */
export function approvalExemptFields(kind: string): readonly string[] {
  const extra: readonly string[] = Object.prototype.hasOwnProperty.call(KIND_APPROVAL_FIELDS, kind)
    ? KIND_APPROVAL_FIELDS[kind as ApprovalKind]
    : [];
  return [...APPROVAL_STAMP_FIELDS, ...extra];
}

/** The ONLY sanctioned way an approval path writes a kind-specific frontmatter map field. `field`
 *  is constrained to `kind`'s own registered list above — passing an unregistered field name for a
 *  given kind fails to type-check, so a new approval-time field literally cannot be written without
 *  first being added to `KIND_APPROVAL_FIELDS` (and therefore, in the same motion, exempted on the
 *  read side). Value shape is enforced separately, by the artifact schema (validateArtifactSource)
 *  that already runs on every write — this helper's job is only the field NAME. */
export function writeApprovalField<K extends ApprovalKind>(
  kind: K,
  src: string,
  field: ApprovalField<K>,
  value: Record<string, string | number | boolean | null | string[]>,
): string {
  return upsertFrontmatterMap(src, field, value);
}
