# Error Monitoring with Sentry

This guide covers setting up Sentry for error tracking and performance monitoring.

## Prerequisites

- Sentry account (free tier available)
- Node.js application with Express

---

## Step 1: Create Sentry Project

1. Go to [sentry.io](https://sentry.io)
2. Create new project: **Express** → **Node.js**
3. Get the DSN (Data Source Name)

---

## Step 2: Install Sentry SDK

```bash
npm install @sentry/node
```

---

## Step 3: Configure

Add to your environment files:

```env
# .env.staging
SENTRY_DSN=https://xxxxx@sentry.io/staging-project
SENTRY_TRACES_SAMPLE_RATE=0.1
APDEX_T_MS=1000
SENTRY_APDEX_PROJECT_T_MS=1000
SENTRY_APDEX_PROJECT_CONFIGURED=true

# .env.production
SENTRY_DSN=https://xxxxx@sentry.io/production-project
SENTRY_TRACES_SAMPLE_RATE=0.1
APDEX_T_MS=1000
SENTRY_APDEX_PROJECT_T_MS=1000
SENTRY_APDEX_PROJECT_CONFIGURED=true
```

`SENTRY_APDEX_PROJECT_CONFIGURED=true` is an operator acknowledgement, not a
secret. Before setting it, configure the same threshold in the Sentry project:

**Project → Settings → Performance → Response Time Threshold (Apdex)**

The Node SDK does not expose this Sentry project threshold as an SDK option or
as a documented project API field. The application therefore uses `APDEX_T_MS`
for its own Apdex calculation, tags transactions with the declared value, and
fails Phase 0 readiness until the Sentry project setting has been confirmed.
The readiness endpoint reports the threshold, project path, and confirmation
state so deployment checks can verify the contract.

---

## Step 4: Integrate with Express

In your `server.js`:

```javascript
const { sentryRequestHandler, sentryErrorHandler } = require('./src/config/sentry');

// Add Sentry middleware BEFORE other middleware
app.use(sentryRequestHandler());

// Your routes and other middleware

// Add error handler BEFORE errorHandler middleware
app.use(sentryErrorHandler());

// Your existing error handler
app.use(errorHandler);
```

---

## Step 5: Track Custom Events

```javascript
const { captureError } = require('./src/config/sentry');

// Capture custom error
try {
  await doSomething();
} catch (err) {
  captureError(err, { userId: user._id });
}

// Or directly
const { Sentry } = require('./src/config/sentry');
Sentry.captureMessage('User action logged', 'info');
Sentry.captureException(err);
```

---

## Features

### Error Tracking
- Automatic error capture in Express routes
- Stack traces with source maps
- Environment/context (user, tags)

### Performance Monitoring
- Transaction tracking
- Endpoint response times
- PostgreSQL query and pool performance
- Application Apdex using the declared `APDEX_T_MS` contract

### Release Tracking
- Links errors to deployment
- Shows which release introduced bug

---

## Environment Setup

| Environment | DSN | Sample Rate | Apdex contract |
|-------------|-----|-------------|----------------|
| Development | Optional | 10% default | Optional |
| Staging | Required | 10% | Required and confirmed |
| Production | Required | 10% | Required and confirmed |

---

## Best Practices

1. **Use appropriate sample rates** - Higher in dev, lower in prod
2. **Add user context** - When user is authenticated:
   ```javascript
   Sentry.setUser({ id: user._id, email: user.email });
   ```
3. **Add tags** - For filtering:
   ```javascript
   Sentry.setTag('company_id', companyId);
   ```

---

## Viewing Errors

1. **Dashboard**: https://sentry.io/[your-org]/
2. **Issues**: All errors grouped
3. **Performance**: Transaction traces
4. **Releases**: Deployment tracking

---

## Troubleshooting

### "No DSN provided"
- Check SENTRY_DSN in your .env file

### "Events not showing"
- Check filter settings in Sentry dashboard
- Verify sample rate isn't 0

### "Performance too verbose"
- Reduce tracesSampleRate in config