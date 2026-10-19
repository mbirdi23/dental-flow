// The patient-flow state machine.
//
// Each transition is triggered by one button click somewhere in the app.
// A transition may START a gap timer (patient now unattended), STOP a gap
// timer (staff member has arrived), both, or neither (e.g. completing the
// visit, or doing paperwork — attended, no timer).
//
// gap_number / waiting_for pairs:
//   1  assistant
//   2  hygienist
//   3  doctor
//   4  treatment_coordinator
//
// (There used to be a 5th gap for checkout. It's been removed — checkout
// is now a direct "Complete Visit" click once TC is done, and paperwork
// moved to the front of the visit instead, as an attended/no-timer stage.
// waiting_checkout / with_checkout stay defined in the label maps below
// purely so old completed visits still display correctly in the Activity
// Log and Analytics — they're no longer reachable going forward.)

const TRANSITIONS = {
  start_paperwork: {
    // Check-in: front desk is helping them fill out paperwork. Attended,
    // so no gap timer runs yet.
    from: ['arrived'],
    to: 'doing_paperwork',
  },
  ready_for_assistant: {
    // Paperwork's done — now they're actually waiting, unattended.
    from: ['doing_paperwork'],
    to: 'waiting_assistant',
    startsGap: { number: 1, waitingFor: 'assistant' },
  },
  assign_operatory: {
    // Assistant has taken the patient back to an operatory. Requires an
    // `operatory` value in the request body (e.g. "OP3").
    from: ['waiting_assistant'],
    to: 'with_assistant',
    stopsGap: 1,
    requiresOperatory: true,
  },
  waiting_hygiene: {
    from: ['with_assistant'],
    to: 'waiting_hygiene',
    startsGap: { number: 2, waitingFor: 'hygienist' },
  },
  with_hygiene: {
    from: ['waiting_hygiene'],
    to: 'with_hygiene',
    stopsGap: 2,
  },
  waiting_doctor: {
    from: ['with_hygiene'],
    to: 'waiting_doctor',
    startsGap: { number: 3, waitingFor: 'doctor' },
  },
  with_doctor: {
    from: ['waiting_doctor'],
    to: 'with_doctor',
    stopsGap: 3,
  },
  waiting_tc: {
    from: ['with_doctor'],
    to: 'waiting_tc',
    startsGap: { number: 4, waitingFor: 'treatment_coordinator' },
  },
  with_tc: {
    from: ['waiting_tc'],
    to: 'with_tc',
    stopsGap: 4,
  },
  complete: {
    // Checkout is no longer its own tracked stage — once TC is done, the
    // visit completes directly.
    from: ['with_tc'],
    to: 'completed',
    completesVisit: true,
  },
};

// What the operatory screen's single big button should say/do for a given
// current status. Keeps the UI to one action at a time.
//
// waiting_tc / with_tc are intentionally NOT here: the patient has moved to
// the TC Room, which is its own screen/station with its own queue.
const NEXT_ACTION = {
  waiting_assistant: null, // handled at front desk (assign_operatory)
  with_assistant: { action: 'waiting_hygiene', label: 'Waiting for Hygienist' },
  waiting_hygiene: { action: 'with_hygiene', label: "I'm With Patient" },
  with_hygiene: { action: 'waiting_doctor', label: 'Waiting for Doctor' },
  waiting_doctor: { action: 'with_doctor', label: "I'm With Patient" },
  with_doctor: { action: 'waiting_tc', label: 'Waiting for Treatment Coordinator' },
};

// The TC Room screen's action button. With checkout removed, finishing up
// with TC now completes the visit directly.
const TC_NEXT_ACTION = {
  waiting_tc: { action: 'with_tc', label: "I'm With Patient" },
  with_tc: { action: 'complete', label: 'Complete Visit' },
};

// The "My Room" screen (a single OP station's dedicated view) can carry a
// patient all the way through completion without leaving that screen —
// this is a superset of NEXT_ACTION + TC_NEXT_ACTION. TC Room and Front
// Desk remain fully functional in parallel; whichever screen acts first
// just wins (the transition endpoint already guards against acting twice
// on the same status).
const FULL_NEXT_ACTION = {
  with_assistant: { action: 'waiting_hygiene', label: 'Waiting for Hygienist' },
  waiting_hygiene: { action: 'with_hygiene', label: "I'm With Patient" },
  with_hygiene: { action: 'waiting_doctor', label: 'Waiting for Doctor' },
  waiting_doctor: { action: 'with_doctor', label: "I'm With Patient" },
  with_doctor: { action: 'waiting_tc', label: 'Waiting for Treatment Coordinator' },
  waiting_tc: { action: 'with_tc', label: "I'm With Patient" },
  with_tc: { action: 'complete', label: 'Complete Visit' },
};

const WAITING_STATUSES = new Set([
  'waiting_assistant',
  'waiting_hygiene',
  'waiting_doctor',
  'waiting_tc',
]);

// Stations staff log into on each device. Each is a physical screen, not a
// person. Used by the frontend to render the login picker and tag actions
// with a `role` for the audit trail (see gap_events.started_by_role).
const STATIONS = ['Upfront', 'OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6', 'Lab', 'TC Room', 'Back Office'];

// Human-readable labels, shared with the client copies in public/js/common.js
// (kept in sync manually since this is plain Node with no bundler/shared module).
// waiting_checkout / with_checkout are kept here (display-only, no longer
// reachable) purely so old completed visits still render correctly.
const STATUS_LABEL = {
  arrived: 'Checked In',
  doing_paperwork: 'Doing Paperwork',
  waiting_assistant: 'Waiting Room',
  with_assistant: 'Pulled Back',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Waiting for Checkout (retired)',
  with_checkout: 'With Checkout (retired)',
  completed: 'Completed',
  cancelled: 'Cancelled / No-Show',
};

// Only these are offered on the manual-edit status dropdown — the
// retired checkout statuses stay out of STATUS_OPTIONS on purpose, even
// though their labels above still exist for historical display.
const STATUS_OPTIONS = [
  'arrived', 'doing_paperwork', 'waiting_assistant', 'with_assistant',
  'waiting_hygiene', 'with_hygiene', 'waiting_doctor', 'with_doctor',
  'waiting_tc', 'with_tc', 'completed', 'cancelled',
];

const ACTION_LABEL = {
  start_paperwork: 'Checked In',
  ready_for_assistant: 'Paperwork Complete',
  assign_operatory: 'Assigned Operatory',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Ready for Checkout (retired)',
  with_checkout: 'With Checkout (retired)',
  complete: 'Completed Visit',
  manual_edit: 'Manual Edit',
  cancel_visit: 'Cancelled / No-Show',
  toggle_flag: 'Treatment Flag Changed',
};

// Used by the manual-edit (override) endpoint: if staff jump a visit
// straight to one of these statuses, this is the gap that should start.
const GAP_FOR_STATUS = {
  waiting_assistant: { number: 1, waitingFor: 'assistant' },
  waiting_hygiene: { number: 2, waitingFor: 'hygienist' },
  waiting_doctor: { number: 3, waitingFor: 'doctor' },
  waiting_tc: { number: 4, waitingFor: 'treatment_coordinator' },
};

module.exports = {
  TRANSITIONS,
  NEXT_ACTION,
  TC_NEXT_ACTION,
  FULL_NEXT_ACTION,
  WAITING_STATUSES,
  STATIONS,
  STATUS_LABEL,
  STATUS_OPTIONS,
  ACTION_LABEL,
  GAP_FOR_STATUS,
};
