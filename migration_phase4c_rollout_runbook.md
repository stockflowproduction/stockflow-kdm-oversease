# Phase 4C Mongo Read Rollout Runbook

## Scope
This runbook covers **operational rollout only** for Phase 4C Mongo read-path activation.

- No frontend changes
- No write-path changes
- No API contract changes
- Read-path flags only

---

## 1) Staging rollout steps

1. Confirm backend build is green:
   - `cd backend && npm run build`
2. Set staging environment flags:
   - `USE_MONGO_READS=true`
   - `SHADOW_COMPARE=true`
   - `ENABLE_DEV_ROUTES=false`
3. Restart staging backend with new env.
4. Run smoke checks for protected API routes (with valid auth):
   - `GET /api/v1/products`
   - `GET /api/v1/customers`
   - `GET /api/v1/transactions`
   - `GET /api/v1/transactions/deleted`
5. Verify response schema parity with baseline contract fixtures (no field removals/renames).
6. Observe logs for at least one business cycle window and confirm:
   - steady `[MONGO][READ][SUCCESS]`
   - zero/near-zero `[MONGO][READ][ERROR]`
   - zero/near-zero `[MONGO][READ][FALLBACK]`
   - no sustained `[MONGO][READ][SHADOW_MISMATCH]`
7. If stable, proceed to production preflight.

---

## 2) Production preflight checks

Before enabling Mongo reads in production:

1. Confirm latest deployment artifact passed backend build.
2. Confirm Mongo connectivity/health checks pass in prod network path.
3. Confirm Firestore read fallback path remains enabled in current release.
4. Confirm on-call + rollback owner are assigned for rollout window.
5. Confirm log aggregation dashboards/alerts include Mongo read markers.
6. Confirm feature flags can be changed and rolled back quickly (env + restart plan documented).
7. Confirm `ENABLE_DEV_ROUTES=false` in production.
8. Confirm no pending backend contract migrations are bundled with rollout.

---

## 3) Required env flags

### Staging and Production (initial Phase 4C rollout)

```env
USE_MONGO_READS=true
SHADOW_COMPARE=true
ENABLE_DEV_ROUTES=false
```

### Emergency rollback (read-path only)

```env
USE_MONGO_READS=false
```

> Keep `ENABLE_DEV_ROUTES=false` in staging/prod throughout rollout.

---

## 4) Monitoring signals

Track these structured markers continuously during rollout:

- `[MONGO][READ][SUCCESS]`
  - Expected dominant signal after enablement.
- `[MONGO][READ][ERROR]`
  - Indicates Mongo read failure.
- `[MONGO][READ][FALLBACK]`
  - Indicates request served via Firestore fallback after Mongo error.
- `[MONGO][READ][SHADOW_MISMATCH]`
  - Indicates result drift between Mongo and Firestore in comparison mode.

### Operational thresholds (recommended)

- `ERROR` and `FALLBACK`: investigate immediately on spikes or sustained non-zero rates.
- `SHADOW_MISMATCH`: investigate any sustained mismatch trend, even if user-visible behavior is unaffected.

---

## 5) Rollback command

If Mongo read-path instability is detected:

1. Set:
   - `USE_MONGO_READS=false`
2. Restart backend.
3. Verify traffic now shows Firestore-only success path and fallback/error signals normalize.

---

## 6) Criteria to turn `SHADOW_COMPARE=false`

Turn off shadow compare only when all are true:

1. Mongo read success is stable over agreed observation window.
2. Mongo error/fallback rates are at or near zero and non-trending.
3. Shadow mismatches are zero or explained/resolved with documented sign-off.
4. Product, customer, transaction, and deleted transaction read parity is confirmed.
5. Stakeholders (backend owner + on-call + release owner) approve transition.

Recommended transition flags:

```env
USE_MONGO_READS=true
SHADOW_COMPARE=false
ENABLE_DEV_ROUTES=false
```

---

## 7) NO-GO conditions

Do **not** proceed (or halt rollout) if any of the following occur:

1. Sustained `[MONGO][READ][ERROR]` above agreed threshold.
2. Sustained `[MONGO][READ][FALLBACK]` indicating persistent Mongo instability.
3. Repeated `[MONGO][READ][SHADOW_MISMATCH]` without root-cause resolution.
4. Any API contract drift detected on read responses.
5. Any sign of write-path regression during read rollout window.
6. `ENABLE_DEV_ROUTES=true` detected in staging/prod runtime config.

---

## 8) Final sign-off checklist

- [ ] Backend build passed in release artifact.
- [ ] Required flags set correctly for rollout stage.
- [ ] Dev routes disabled (`ENABLE_DEV_ROUTES=false`).
- [ ] Read endpoints smoke-tested with auth.
- [ ] Mongo SUCCESS dominates logs.
- [ ] ERROR/FALLBACK signals within acceptable limits.
- [ ] SHADOW_MISMATCH reviewed and resolved/accepted.
- [ ] Rollback path validated (`USE_MONGO_READS=false` + restart).
- [ ] On-call sign-off captured.
- [ ] Release owner sign-off captured.

---

## Flag profiles by phase

### Phase 4C rollout

```env
USE_MONGO_READS=true
SHADOW_COMPARE=true
ENABLE_DEV_ROUTES=false
```

### Post-stabilization profile

```env
USE_MONGO_READS=true
SHADOW_COMPARE=false
ENABLE_DEV_ROUTES=false
```
