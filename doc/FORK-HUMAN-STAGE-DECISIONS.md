# Human execution stage decisions in this fork

This fork adds a decision form for an existing review/approval stage assigned to
the signed-in person. In task Properties, open Execution, write a comment and
choose Approve or Request changes. The form submits one native issue update
containing the status and comment. It appears only while that person's stage is
pending. It introduces no new database schema, endpoint, permission or company
team layout.

The baseline is Paperclip v2026.1106.0, commit
`d69631b01b9c658f80bf8bed389863dce82643e1`. The native server already requires a
decision comment in the same request; a prior comment is insufficient. Existing
stalled-review controls serve another case and are unchanged.

## Verification and limits

The component suite covers the permitted actor, absent controls, mandatory
comment, combined updates, stale reads, navigation, duplicate submission,
permission refusal and uncertain write receipts. Requests are mocked. A preflight
read reduces stale submissions but is not a server-side compare-and-swap guarantee.
Full repository typecheck, complete tests, release build and live persisted
workflow acceptance must be recorded separately before deployment readiness.

## Installation and updates

Keep the native managed installer and service. Select this fork and an exact
tested commit in the instance profile when the fresh-install setup is finalized.
No company team, instruction, credential or host configuration belongs here.
The current project setup scripts still target the older customized release;
their replacement and fresh-host acceptance remain pending. This source change
is not permission to deploy or alter an existing instance.

For another upstream release, merge/rebase onto its exact reviewed commit, resolve
conflicts explicitly and run the affected tests plus release checks. Do not
replay a byte patch over a different UI. Preserve previous tested commit IDs for
code rollback; database/file recovery is separate.

## Retiring the fork change

When upstream provides the same designated-human stage decision form, verify both
actions include their comments and retain native actor checks, stale-state
handling and uncertain-write behavior. Then remove this component, test and
Properties insertion on the new release and update the setup selection. Do not
use the longstanding stalled-review buttons alone as evidence of replacement.
