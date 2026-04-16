# Project goal
This is a polling system that monitors Finland Migri appointment slots on https://migri.vihta.com/public/migri/ and tries to move your appointment to an earlier time as soon as a better slot appears. Slots are scarce and someone else's cancellations will briefly release much earlier times; this program will keep polling and react quickly.

# Design
The program runs in the background using two independent poll loops:
- Periodically fetch your appointment data using Migri's appointment APIs and store its current start time.
- Periodically fetch upcoming available slots for your appointment, starting from today in UTC. If there is a better slot then reschedule the appointment to this slot.
- Write current status snapshot into `status.json`.
- Whenever the pool's earliest slot change, append a log line to `changes.txt` to track how the calendar evolves.

Appointment rescheduling rules:
- Only consider slots earlier than the current booked appointment.
- In normal mode, skip slots whose Helsinki local date is earlier than the appointment's `min-date` and log them as missed opportunities.
- When trying to move an appointment, sort the earlier slots, try the best valid candidate first, and if that modify call fails (i.e. someone else snatches it quicker than us), then try exactly one second candidate, never a third.
- `--best` is an emergency one-shot mode: run the appointment tick once and the slot tick once, bypass the min-date gating, then exit.

The system does not send its own notifications. Appointments are configured from `.env` as `APPOINTMENT1`, `APPOINTMENT2`, ... with `key:pin:type[:min-date]`, where type is currently `prp` or `work`. `min-date` is optional and, when provided as `YYYY-MM-DD`, prevents rescheduling to any earlier Helsinki local date; when omitted, it defaults to today in Helsinki. Order in `.env` matters: earlier entries get first chance at the best slot. Human-readable logs use Helsinki timezone, while API request dates and timestamps stay in UTC. The code should stay extremely simple: plain JavaScript, Node.js runtime, one `index.js` file.

## Notes
- **`status.json`** is rewritten after each appointment poll and after each slots poll. It holds a snapshot of our tracked appointments, the earliest open slot the tool last tracked per permit **type**, and other metadata.
- **`changes.txt`** is append-only: whenever the **earliest visible slot in the pool** for a service (PRP/basis of work/etc...) changes compared to the last time the tool recorded it, a line is added (formated in Helsinki time zone).

# Migri's appointment API

This is the API reverse-engineered from the website https://migri.vihta.com/public/migri. It is not an official documentation and, not comprehensive and might get out-of-date in the future. But for now it is sufficient to do the job. 

These constant parameters are used universally on all APIs to refer to Migri offices and services.
- `<office-id>`:
    "438cd01e-9d81-40d9-b31d-5681c11bd974" is for the Helsinki migri service point (Malmi).
    There are other offices too, but I don't care about them.
- `<service-id>`:
    "3e03034d-a44b-4771-b1e5-2c4a6f581b7d" is for Finnish permanent residence permit. "2906a690-4c8c-4276-bf2b-19b8cf2253f3" for Finnish residence permit on basis of work.
    There are other services, but I don't care about them.


## Get session
```
GET https://migri.vihta.com/public/migri/api/sessions
```
Response:
```
{
    "id": "f62ca440-714c-439d-ad24-58df9127b9c2",
    "isAnon": true,
    "isKeycloak": false,
    "languageCode": "",
    "userDisplayName": "",
    "userId": ""
}
```
The "id" string is the session ID required for subsequential API calls, must be later attached in request header "vihta-session".

## Get upcoming available slots
```
POST https://migri.vihta.com/public/migri/api/upcoming/services?end_hours=24&max_amount=24&mode=SINGLE&office_id=<office-id>&start_date=<yyyy-MM-dd>&start_hours=0
```

Import URL query params:
  - start_date: replace with today in format yyyy-MM-dd.
  - office_id: "438cd01e-9d81-40d9-b31d-5681c11bd974" is for the Helsinki migri service point (Malmi).
  - Other params keep as is.

Required headers:
  - Content-Type: application/json
  - Content-Length: <calculated when request is sent>
  - Host: <calculated when request is sent>
  - vihta-session: <the session ID retrieved from Get session API>

Required JSON body:
```
  {"serviceSelections":[{"values":[<service-id>]}],"extraServices":[]}
```

Response:
```
{
    "availabilities": [
        {
            "startTimestamp": "2026-07-23T09:30:00.000Z"
        },
        {
            "startTimestamp": "2026-07-23T10:00:00.000Z"
        },
        {
            "startTimestamp": "2026-07-23T11:00:00.000Z"
        },
        ...
    ]
}
```

There are other fields in the repsonse as well, but we don't care about them.

## Check appointment PIN code
When an appointment is reserved, the website will send to us 2 string values: the appointment key (e.g. "2fxxxx"), and the PIN code (e.g. "abxxxx"). These 2 values are used for authentication during reschedule/cancel. This API submits the key and the PIN to check if the pair is valid, then in the response there is a header `Set-Cookie: AUTHCHECK=<auth-string>`, we need to extract the auth string to be used in later appoinment management APIs.

```
POST https://migri.vihta.com/public/migri/api/allocations/key/<key>/pintest
```

Headers:
  - vihta-session: the session ID retrieved from Get session API

Body (form-data):
  - allocation_pin: your-PIN-code

Response is plain-text string `Pin is valid` with status 200 OK if valid, or status 403 Forbidden and rendered HTML if invalid.

## Get booked appointment
```
GET https://migri.vihta.com/public/migri/api/allocations/key/<key>
```

Required header:
  - Cookie: AUTHCHECK=`<auth-string>`
  - vihta-session: `<the session ID retrieved from Get session API>`


Response:
```
{
    "attachments": [],
    "cancellation": {
        "cancellable": true,
        "maxInstant": "2026-07-23T06:00:00.000Z",
        "onlyDuringOpenHours": false
    },
    "classifications": [],
    "customerPermissions": {
        "isCancelable": true,
        "isMovable": true
    },
    "duration": "PT30M",
    "expiresAfter": "PT58M",
    "extraServices": [],
    "id": "36942fb2-9211-46e9-a1f4-5a4cfe4a2f4e",
    "key": "2fxxxx",
    "mode": "SINGLE",
    "numberOfPersons": 1,
    "officeId": "438cd01e-9d81-40d9-b31d-5681c11bd974",
    "participants": [],
    "queueNumber": "-",
    "resourceId": "fb5a469e-61d8-4477-ad6c-1fb1535b24f9",
    "serviceId": "2906a690-4c8c-4276-bf2b-19b8cf2253f3",
    "serviceIds": [
        "2906a690-4c8c-4276-bf2b-19b8cf2253f3"
    ],
    "start": "2026-07-23T10:00:00.000Z",
    "state": "ACCEPTED",
    "subReservationServices": []
}
```

Notes:
  - The fields "id" and "resourceId" are used to identify this appointment for cancel/reschedule

## Modify appointment
```
POST https://migri.vihta.com/public/migri/api/allocations/modify/<id>?office_id=<office-id>&resource_id=<resource-id>&start_timestamp=2026-07-23T10:00:00.000Z
```

Important URL query params:
  - "start_timestamp": new appointment time in ISO 8601, UTC. Must be from an existing available slot.  

Required header:
  - Cookie: AUTHCHECK=`<auth-string>`
  - vihta-session: `<the session ID retrieved from Get session API>`
  - Content-Type: `application/x-www-form-urlencoded`

Body (x-www-form-urlencoded):
  - allocation_pin: abxxxx

Response is plain-text "Allocation modified" with status code 200. Once completed, it will send an email to the appointment's owner.