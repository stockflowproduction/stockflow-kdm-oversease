# Freight Inquiry UI – Latest Updates

This document captures the latest UI refinements made to the **Freight Inquiry** flow in `pages/FreightBooking.tsx`.

## What changed

### 1) Exact-variant flow reorganized for clarity
The exact-variant section now follows a clearer sequence:
1. Select variant/color rows from a compact selector table.
2. Enter shared order values.
3. Click **Apply to Selected Variants**.
4. Review/edit only the applied variant rows in the calculation area.

This replaces the previous dense mixed table where selection and calculations were interleaved.

### 2) Selected vs Applied state introduced
A dedicated applied state is now used so that:
- selecting rows does not immediately include them in calculations,
- only applied rows are used for exact totals and save payload,
- users can control when rows should participate in final computation.

### 3) Validation behavior improved for exact mode
Validation is now aligned with the apply workflow:
- prompts users to apply rows before final validation,
- distribution mismatch checks are shown only when relevant,
- reduces premature/confusing warnings while users are still preparing rows.

### 4) Single-variant order-level convenience retained
For exact mode with order-level quantity and a single applied variant:
- full order quantity is auto-assigned to that row,
- mismatch warnings are not shown for that expected case.

### 5) Applied-row editing/removal remains available
In the final exact calculation area:
- users can still remove rows safely,
- unselected or unapplied rows are excluded from final exact calculations.

## Outcome
These updates keep the same business rules and save semantics while making the Freight Inquiry exact-mode UI easier to understand and less error-prone.
