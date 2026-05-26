# ERP Mismatch, Risk Gate, and Readiness Decision Template

## 1) Mismatch Review Template (repeat per mismatch)

- **Dimension:**
- **Severity:**
- **Legacy value:**
- **Ledger value:**
- **Delta:**
- **Audit findings:**
- **Source event IDs:**
- **Explanation:**
- **Reviewer decision:** accepted | unresolved | blocked
- **Required follow-up:**
- **Accounting sign-off:**

---

## 2) Risk Gate Review Template (repeat per gate)

- **Gate ID:**
- **Status:**
- **Reason:**
- **Related suggestions:**
- **Reviewer notes:**
- **Migration allowed?** yes | no

---

## 3) Migration Readiness Decision Template

- **blockedGateCount:**
- **warningGateCount:**
- **critical mismatches remaining:**
- **unresolved accounting ambiguities:**
- **fallback inference status:**
- **supplier duplication status:**
- **refund linkage status:**

### Recommendation

- hold
- proceed with more validation
- candidate for limited migration pilot

**Selected recommendation:**

**Decision rationale:**

---

## 4) Explicit Review Rules

- No migration allowed without manual accounting review.
- No migration allowed with unresolved blocked gates.
- No production formula replacement without archived evidence packs.
- No auto-repair allowed.
