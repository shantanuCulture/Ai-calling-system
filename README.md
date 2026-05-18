# AI Call System

A production-ready full-stack AI calling system built with **Node.js + Express** (backend) and **React** (frontend), integrating **Twilio** for telephony and **Vapi** for AI voice agents (STT + LLM + TTS).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Setup & Installation](#setup--installation)
4. [Environment Variables](#environment-variables)
5. [Twilio Configuration](#twilio-configuration)
6. [Vapi Configuration](#vapi-configuration)
7. [System Flows](#system-flows)
   - [Inbound Call Flow](#inbound-call-flow)
   - [Outbound Call Flow](#outbound-call-flow)
   - [Human Escalation Flow](#human-escalation-flow)
   - [Vapi Tool Handler](#vapi-tool-handler)
8. [API Reference](#api-reference)
9. [Frontend Dashboard](#frontend-dashboard)
10. [Development with ngrok](#development-with-ngrok)
11. [Scalability & Future Expansion](#scalability--future-expansion)

---

## Architecture Overview

```
Customer Phone
      │
      ▼
  Twilio PSTN
      │  POST /api/twilio/incoming-call
      ▼
  Backend (Express)
      │  returns TwiML → <Dial><Sip>sip:ASSISTANT_ID@sip.vapi.ai</Sip></Dial>
      ▼
  Vapi AI Assistant
   ├── STT  (speech to text)
   ├── LLM  (GPT-4 / Claude)
   └── TTS  (text to speech)
      │
      │  POST /api/vapi/tool   (when AI needs data)
      ▼
  Backend Tool Handler
   ├── checkTourAvailability
   ├── getAgentDetails
   ├── saveLead
   └── transferToHuman
      │
      │  if human needed:
      ▼
  POST /api/twilio/transfer-call → <Dial><Number>agent phone</Number></Dial>
      │
      ▼
  Human Agent Phone
```

---

## Project Structure

```
ai-call-system/
├── backend/
│   ├── server.js                     # Entry point
│   ├── .env.example                  # Environment template
│   ├── package.json
│   └── src/
│       ├── app.js                    # Express setup, middleware, routes
│       ├── config/
│       │   └── index.js              # Centralised env config
│       ├── controllers/
│       │   ├── twilioController.js   # Twilio webhook handlers
│       │   ├── vapiController.js     # Vapi tool-call dispatcher
│       │   ├── callController.js     # Outbound calls + logs
│       │   └── agentController.js   # Agent CRUD
│       ├── routes/
│       │   ├── twilio.js
│       │   ├── vapi.js
│       │   ├── call.js
│       │   └── agent.js
│       ├── services/
│       │   ├── twilioService.js      # TwiML generators + Twilio API calls
│       │   ├── vapiService.js        # Vapi REST API wrapper
│       │   └── databaseService.js   # Data access layer
│       ├── integrations/
│       │   ├── twilio/index.js       # Twilio client singleton
│       │   └── vapi/index.js         # Axios client for Vapi API
│       ├── database/
│       │   └── mockDb.js             # In-memory data (tours, agents, leads)
│       └── utils/
│           └── logger.js             # Winston logger
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── App.jsx
│       ├── main.jsx
│       ├── index.css
│       ├── services/
│       │   └── api.js               # Axios API client
│       ├── components/
│       │   └── Layout/              # Sidebar + shell
│       └── pages/
│           ├── Dashboard/           # Stats + outbound call trigger
│           ├── CallLogs/            # Call log + leads tables
│           └── AgentManagement/     # Agent CRUD
└── README.md
```

---

## Setup & Installation

### Prerequisites

- Node.js 18+
- A [Twilio](https://twilio.com) account with a phone number
- A [Vapi](https://vapi.ai) account with an AI assistant created
- [ngrok](https://ngrok.com) (for local development webhooks)

### 1. Clone / enter the project

```bash
cd ai-call-system
```

### 2. Backend setup

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your credentials
npm run dev      # starts on port 3001 with nodemon
```

### 3. Frontend setup

```bash
cd frontend
npm install
npm run dev      # starts on port 3000, proxies /api → localhost:3001
```

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Description |
|---|---|
| `PORT` | Backend port (default: 3001) |
| `NODE_ENV` | `development` or `production` |
| `TWILIO_ACCOUNT_SID` | Found in Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Found in Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Your Twilio number in E.164 format (e.g. `+18001234567`) |
| `VAPI_API_KEY` | Vapi dashboard → Settings → API Keys |
| `VAPI_ASSISTANT_ID` | Vapi dashboard → Assistants → your assistant ID |
| `BASE_URL` | Public URL where the backend is reachable (ngrok URL in dev) |

---

## Twilio Configuration

### Inbound calls

1. Go to [Twilio Console → Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/active).
2. Click your phone number.
3. Under **"Voice & Fax"**, set:
   - **A CALL COMES IN**: Webhook → `POST`
   - URL: `https://YOUR_DOMAIN/api/twilio/incoming-call`
4. Save.

### Status callbacks

These are configured automatically in `twilioService.initiateOutboundCall()` using `BASE_URL`.

---

## Vapi Configuration

### Create an assistant

1. Log in to [app.vapi.ai](https://app.vapi.ai).
2. Create a new assistant (choose model, voice, system prompt).
3. Under **"Functions"**, add the following tools with their schemas:

#### `checkTourAvailability`
```json
{
  "name": "checkTourAvailability",
  "description": "Check if a tour package is available for a given destination",
  "parameters": {
    "type": "object",
    "properties": {
      "destination": { "type": "string", "description": "City or country name" }
    },
    "required": ["destination"]
  }
}
```

#### `saveLead`
```json
{
  "name": "saveLead",
  "description": "Save the caller's details as a lead",
  "parameters": {
    "type": "object",
    "properties": {
      "name":        { "type": "string" },
      "phone":       { "type": "string" },
      "email":       { "type": "string" },
      "destination": { "type": "string" },
      "notes":       { "type": "string" }
    },
    "required": ["phone"]
  }
}
```

#### `getAgentDetails`
```json
{
  "name": "getAgentDetails",
  "description": "Get an available human agent for transfer",
  "parameters": {
    "type": "object",
    "properties": {
      "department": { "type": "string", "enum": ["sales", "support", "billing"] }
    }
  }
}
```

#### `transferToHuman`
```json
{
  "name": "transferToHuman",
  "description": "Escalate the call to a human agent when the AI cannot help",
  "parameters": {
    "type": "object",
    "properties": {
      "reason":     { "type": "string" },
      "department": { "type": "string" }
    }
  }
}
```

4. Under **"Server URL"** (or "Webhook URL"), set:
   ```
   https://YOUR_DOMAIN/api/vapi/tool
   ```

5. Copy the **Assistant ID** and add it to your `.env` as `VAPI_ASSISTANT_ID`.

---

## System Flows

### Inbound Call Flow

```
1. Customer dials toll-free number (Twilio)
2. Twilio sends POST to /api/twilio/incoming-call
3. Backend:
   a. Logs the call (callSid, from, to, direction=inbound)
   b. Returns TwiML:
      <Dial callerId="+18001234567">
        <Sip username="VAPI_API_KEY">sip:ASSISTANT_ID@sip.vapi.ai;transport=tcp</Sip>
      </Dial>
4. Vapi receives the SIP call
5. Vapi AI handles conversation (STT → LLM → TTS loop)
6. When AI needs data, it POSTs to /api/vapi/tool
7. Backend tool handler returns structured JSON
8. If AI triggers transferToHuman tool:
   → see Human Escalation Flow
```

### Outbound Call Flow

```
1. Dashboard (or API) sends POST /api/call/outbound
   Body: { "to": "+15551234567", "customerName": "John", "notes": "Interested in Paris" }

2. Backend calls Twilio API: client.calls.create(...)
   - from: TWILIO_PHONE_NUMBER
   - to:   customer number
   - url:  BASE_URL/api/twilio/outbound-vapi?assistantId=...

3. Twilio dials the customer
4. Customer answers → Twilio fetches /api/twilio/outbound-vapi
5. Backend returns same TwiML (SIP → Vapi)
6. AI begins the outbound conversation
7. Status callbacks fire to /api/twilio/call-status (updates call log)
```

### Human Escalation Flow

```
1. AI detects it cannot answer OR customer asks "speak to a person"
2. AI calls the transferToHuman tool
3. Backend looks up an available agent (by department)
4. AI receives agent details in tool response
5. Vapi triggers a SIP transfer OR the frontend calls:
   POST /api/twilio/transfer-call
   Body: { "department": "sales", "callSid": "CA..." }

6. Backend returns TwiML:
   <Say>Please hold while we connect you to an agent.</Say>
   <Dial callerId="+18001234567" timeout="30"
         action="/api/twilio/transfer-fallback">
     <Number>+15551234567</Number>
   </Dial>

7. Twilio dials the agent
   ✓ Agent answers  → both legs bridged
   ✗ Agent no-answer→ Twilio POSTs to /api/twilio/transfer-fallback
                      Backend returns apologetic TwiML message
```

### Vapi Tool Handler

`POST /api/vapi/tool` receives Vapi's tool-call webhook and dispatches to:

| Tool | Parameters | Returns |
|---|---|---|
| `checkTourAvailability` | `destination` (string) | availability, price, dates |
| `saveLead` | `name`, `phone`, `email`, `destination`, `notes` | leadId, confirmation |
| `getAgentDetails` | `agentId` or `department` | agent name, phone |
| `transferToHuman` | `reason`, `department` | agent available, transfer number |

---

## API Reference

### Twilio Webhooks (called by Twilio)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/twilio/incoming-call` | Inbound call webhook |
| POST | `/api/twilio/transfer-call` | Initiate human transfer |
| POST | `/api/twilio/transfer-fallback` | Agent no-answer fallback |
| POST | `/api/twilio/outbound-vapi` | Attach Vapi to outbound call |
| POST | `/api/twilio/call-status` | Status callback |

### Vapi Webhook (called by Vapi)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/vapi/tool` | Tool/function call handler |

### Call Management (called by frontend / client)

| Method | Endpoint | Body / Params | Purpose |
|---|---|---|---|
| POST | `/api/call/outbound` | `{ to, customerName, notes }` | Start outbound call |
| GET | `/api/call/logs` | — | Get all call logs |
| GET | `/api/call/leads` | — | Get all leads |

### Agent Management

| Method | Endpoint | Body | Purpose |
|---|---|---|---|
| GET | `/api/agents` | — | List all agents |
| POST | `/api/agents` | `{ name, phone, department, email }` | Create agent |
| PUT | `/api/agents/:id` | any agent fields | Update agent |
| DELETE | `/api/agents/:id` | — | Delete agent |

---

## Frontend Dashboard

| Page | Route | Description |
|---|---|---|
| Dashboard | `/` | Stats cards, system flow diagram, outbound call form |
| Call Logs | `/call-logs` | Paginated call log table + leads tab |
| Agents | `/agents` | Agent cards with add / edit / delete / toggle availability |

The frontend dev server proxies all `/api` requests to `http://localhost:3001` via Vite's proxy config.

---

## Development with ngrok

Twilio and Vapi need a public HTTPS URL to reach your local server.

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3001
# e.g. output: https://abc123.ngrok.io

# Set in backend/.env:
BASE_URL=https://abc123.ngrok.io
```

Then update:
- Twilio Phone Number webhook → `https://abc123.ngrok.io/api/twilio/incoming-call`
- Vapi assistant server URL  → `https://abc123.ngrok.io/api/vapi/tool`

---

## Scalability & Future Expansion

### Database
Replace `backend/src/database/mockDb.js` + `databaseService.js` with any real database (MongoDB, PostgreSQL). Only `databaseService.js` needs to change — no controllers or routes are affected.

### Multi-assistant
Pass `assistantId` as a query parameter to `/api/twilio/outbound-vapi` or in the POST body of `/api/call/outbound`. Different use-cases (sales, support, billing) can use different Vapi assistants.

### Authentication
Add JWT middleware to routes in `src/app.js` before the route registrations. The Twilio webhook endpoints should be validated using Twilio's request signature (`twilio.validateExpressRequest`).

### Analytics
The `callLogs` and `leads` arrays in `mockDb.js` are the foundation. Pipe them to a time-series store (InfluxDB, TimescaleDB) or a BI tool (Metabase, Grafana) for dashboards.

### CRM Integration
In `vapiController._saveLead()`, add a CRM call (HubSpot, Salesforce) after `databaseService.saveLead()`.

### Queue / IVR
Add more TwiML `<Gather>` menus in `twilioService.js` to build an IVR before handing off to Vapi, or add a waiting-room queue using Twilio's TaskRouter.

### Deployment
- Backend: Any Node.js host (Railway, Render, Heroku, EC2). Set `NODE_ENV=production`.
- Frontend: Build with `npm run build` and serve from Vercel, Netlify, or the same Node server with `express.static`.
