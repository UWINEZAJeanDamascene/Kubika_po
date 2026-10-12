# POS and EBM Operations Runbook

For store supervisors, finance operations, and workspace administrators. Use the application screens described below. Do not edit the database, delete a POS pending checkout from browser storage, or create a replacement sale until the original transaction is reconciled.

## Roles and screens

- **POS cashier:** POS page; can inspect their own active shift, count cash, close it, and optionally hand it over.
- **POS manager:** can review till shifts, help with handover/opening-float exceptions, and approve a controlled manager close for another cashier's shift.
- **EBM operator:** EBM Control Center, including the **Retry** tab. Requires EBM read/update access (normally admin or stock manager).
- **Invoice operator:** invoice detail page, **EBM Submission** tab. Requires invoice update access.

In the application, open **EBM Control Center** from the Purchases section. Its **Retry** tab is the durable EBM queue. The invoice's own EBM tab shows fiscal status and the fiscal receipt when one has been issued.

## 1. EBM queue item failed

### Triage

1. Open **EBM Control Center → Retry** and filter to the affected status or document type.
2. Open **Error** and record the document type/ID, last error, retryability, attempt history, retry count, and next retry time.
3. Follow the error message. For connectivity/timeouts, check that the EBM device/branch shows ready in **EBM Control Center**. For validation errors, check the invoice/credit note and the branch, customer TIN, product tax/item codes, and required fiscal configuration.
4. Open the source document and confirm that it exists and is the correct transaction. Do not create a new sale to replace a fiscal failure.

### Retry

- **pending, transient error:** if its next retry is still in the future, wait for the scheduled retry and refresh. If it is overdue and readiness is healthy, select **Retry** once and inspect the result.
- **failed, non-retryable error:** fix the source/configuration issue first. For invoice sales, use the invoice detail page's **EBM Submission → Submit fiscal sale** action after verifying RRA did not already accept the document. This submits a payload rebuilt from the current invoice. For other document types, use the relevant source-document resubmission workflow if present; if there is no such workflow, escalate with the queue item ID.
- **abandoned:** this means automatic retry attempts were exhausted. Restore EBM readiness, verify the last error and source document, then use **Retry** once. Manual retry resets the retry count and attempts immediately; repeated retries will not fix a bad payload or unavailable RRA service.
- **bulk retry:** use only for a group with the same resolved transient cause. Bulk retry resets records for the background worker; it does not verify or fix their source data.

Refresh the queue and invoice after the attempt. A successful item should show **submitted** and the invoice should display its RRA receipt details. If the error returns, stop retrying and escalate with the exact RRA error, document ID, branch, and attempt timestamps.

### Do not use “Mark Resolved” as a retry or repair

The queue's **Mark Resolved** action only changes the queue record's status. It does not obtain or attach a fiscal receipt to the invoice. Use it only under an approved reconciliation procedure after RRA acceptance has been independently confirmed and the invoice receipt has been reconciled. If the receipt details are absent, escalate; do not mark the item resolved to clear the alert. **Acknowledge** only acknowledges the alert. **Reset alert** resets the queue item for retry; it is not an acknowledgement-only action.

## 2. Till stuck open / register belongs to another cashier

### If you are the cashier who opened the shift

1. Go to **Direct Sale / POS** on the same register and check the active shift panel.
2. Count the physical cash in the drawer, including the opening float. Enter that count in **Counted cash**; do not copy the expected amount unless that is the actual count.
3. Compare with **Expected cash**. If they differ, enter a short factual explanation in **Variance note** (at least five characters).
4. To hand over, enter the next active cashier's workspace email in **Next cashier email**. Leave it blank if there is no handover.
5. Select **Close Till**. Confirm the shift is shown as closed, then let the next cashier open the same register. When there is a handover, their opening float must match the prior closing count; a mismatch requires a POS manager and an explanation.

Expected cash is the register's recorded cash expectation (opening float plus recorded cash activity). It is not the sale total: card, bank transfer, cheque, and mobile-money receipts do not count as drawer cash.

### If the shift belongs to another cashier

Ask that cashier to sign in, count the drawer, close the shift, and enter your email for handover. If they are unavailable, a cashier or supervisor with POS close access can use the **Manager close & reconcile** control shown under the other cashier's active shift. Enter the physical drawer count, an optional next cashier email, and a factual reason of at least 10 characters. A different manager with `tills:close` permission must enter their workspace credentials (and authenticator code if enabled). The transaction rechecks that the shift is still open, locks it while reading current expected cash, closes it once, records the variance, and appends the requester, approver, reason, and timestamp to the shift activity.

If no separate manager with close permission is available, the shift is already closed, or the displayed cash activity does not match the drawer, do not guess the count or open a second shift. Escalate to the workspace administrator with register name/ID, shift owner, opening time, expected cash, physical count, and sales since opening. Do not alter cashier identity or shift rows directly in the database.

### End-of-shift Z-report

After closing a shift, open **Recent shift reconciliations** and select **Z-report** for that closed shift. The report is linked to the till session and includes sales, discounts, tenders by method, POS refunds, voided invoices, tax buckets, opening float, cash retained from sales, cash refunds, expected drawer cash, physical count, and variance. A cash ledger difference is a review signal: compare the report with the recorded cash activity and linked invoice/refund records before signing off. POS credit-note refunds must be recorded while the cashier has an open till so the refund is attributed to that shift; cash refunds reduce expected drawer cash.

## 3. POS idempotency conflict or checkout pending

POS saves one unresolved checkout per company and cashier in that browser. Its idempotency key protects stock and accounting from duplicate submissions.

### `POS_SALE_STILL_PROCESSING` or “Checkout pending confirmation”

1. Keep the same browser, company, cashier account, and POS tab. Do not edit the cart or start another sale.
2. Check network connectivity, wait briefly, then use **Retry saved sale**. It resends the same saved payload and key; a completed prior request returns the existing invoice instead of making another one.
3. If it remains unresolved for more than ten minutes, search **Invoices** for the cashier, customer, approximate time, and total. Do not assume that a timeout means the sale failed.
4. If the matching invoice exists, note its invoice/reference number and contact support to reconcile the saved checkout. If no matching invoice is visible, still do not create a replacement sale; escalate the request key/check-out time to the workspace administrator/engineering support.

### `POS_IDEMPOTENCY_KEY_CONFLICT`

This means the server has already seen that key with a different cashier or sale payload. Do not keep retrying a modified sale or clear the browser's pending checkout. On the original cashier's POS browser, choose **Review conflict & request manager recovery**. Compare the linked invoice reference, customer, and amount with the saved checkout. Continue only when you have verified the saved checkout does not already have an invoice; enter a factual reason and have a different manager approve with their workspace credentials. The server issues a fresh key for the exact immutable saved payload and records the old/new keys, both payload hashes, invoice, requester, approver, and reason. Then choose **Retry saved sale** once. If the existing key has no linked completed invoice, recovery is blocked and the POS administrator must review it; do not create a replacement sale.

### `POS_IDEMPOTENT_SALE_UNAVAILABLE`

The server says the key completed but cannot load its invoice. Stop checkout on that cashier's device and escalate immediately. Do not make a replacement sale; an administrator must reconcile the request and invoice records.

## 4. Fiscal pending after a POS sale

Fiscal submission is asynchronous: the local invoice and payment can complete while RRA certification is still pending. **Pending is not a failed sale and does not mean the cashier should ring it up again.**

1. Find the invoice through **Invoices** and confirm its payment/stock state and invoice reference.
2. Open the invoice detail page's **EBM Submission** tab. If it is pending only briefly, refresh after a few minutes; the background submission/queue worker runs independently of checkout.
3. If still pending, find the matching document in **EBM Control Center → Retry**. Use the transient/failure steps above. Check for a receipt number, fiscal timestamp/signature, and **submitted** status after recovery.
4. If RRA may already have accepted it, confirm receipt status with the RRA/VSDC record before any manual resubmission. If the queue is marked submitted but the invoice has no fiscal receipt, or RRA accepted it but KUBIKA still has no receipt details, stop and escalate for reconciliation. Do not issue another sale or clear the queue item.

## Escalation handoff

Include:

- Workspace/company, register and cashier, local time with timezone.
- Invoice/document reference and ID, amount/payment method, and whether a matching invoice exists.
- EBM queue ID/status, last error code/message, retry count, next retry time, and attempt history.
- Whether EBM readiness is green and whether RRA shows an accepted fiscal receipt.
- For a till: opening time/float, expected cash, physical count, variance note, and intended next cashier.
- For idempotency: exact error code and the original browser/device; never include passwords, authenticator codes, API tokens, or full payment-card details.

## Resolution checklist

- Till is closed/reconciled or handed to the named next cashier; variance has a factual note.
- POS has one verified invoice for the attempted checkout; no replacement sale was created during uncertainty.
- EBM queue and source document agree on status; submitted invoices have their fiscal receipt details, and unresolved RRA acceptance cases remain escalated rather than hidden.
