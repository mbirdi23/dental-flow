// The patient-flow state machine.
//
// Each transition is triggered by one button click somewhere in the app.
// A transition may START a gap timer (patient now unattended), STOP a gap
// timer (staff member has arrived), both, or neither (e.g. completing the
// visit).
//
// gap_number / waiting_for pairs:
//   1  assistant
//   2  hygienist
//   3  doctor
//   4  treatment_coordinator
//   5  checkout

const TRANSITIONS = {
  ready_for_assistant: {
    from: ['arrived'],
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
  waiting_checkout: {
    from: ['with_tc'],
    to: 'waiting_checkout',
    startsGap: { number: 5, waitingFor: 'checkout' },
  },
  with_checkout: {
    from: ['waiting_checkout'],
    to: 'with_checkout',
    stopsGap: 5,
  },
  complete: {
    from: ['with_checkout'],
    to: 'completed',
    completesVisit: true,
  },
};

// What the operatory screen's single big button should say/do for a given
// current status. Keeps the UI to one action at a time.
//
// waiting_tc / with_tc are intentionally NOT here: the patient has moved to
// the TC Room, which is its own screen/station with its own queue. Likewise
// waiting_checkout / with_checkout are handled at the front desk.
const NEXT_ACTION = {
  waiting_assistant: null, // handled at front desk (assign_operatory)
  with_assistant: { action: 'waiting_hygiene', label: 'Waiting for Hygienist' },
  waiting_hygiene: { action: 'with_hygiene', label: "I'm With Patient" },
  with_hygiene: { action: 'waiting_doctor', label: 'Waiting for Doctor' },
  waiting_doctor: { action: 'with_doctor', label: "I'm With Patient" },
  with_doctor: { action: 'waiting_tc', label: 'Waiting for Treatment Coordinator' },
};

// The TC Room screen's action button, for the two statuses NEXT_ACTION
// above deliberately excludes.
const TC_NEXT_ACTION = {
  waiting_tc: { action: 'with_tc', label: "I'm With Patient" },
  with_tc: { action: 'waiting_checkout', label: 'Ready for Checkout' },
};

const WAITING_STATUSES = new Set([
  'waiting_assistant',
  'waiting_hygiene',
  'waiting_doctor',
  'waiting_tc',
  'waiting_checkout',
]);

// Stations staff log into on each device. Each is a physical screen, not a
// person. Used by the frontend to render the login picker and tag actions
// with a `role` for the audit trail (see gap_events.started_by_role).
const STATIONS = ['Upfront', 'OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6', 'Lab', 'TC Room', 'Back Office'];

// Human-readable labels, shared with the client copies in public/js/common.js
// (kept in sync manually since this is plain Node with no bundler/shared module).
const STATUS_LABEL = {
  arrived: 'Checked In',
  waiting_assistant: 'Waiting Room',
  with_assistant: 'Pulled Back',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Waiting for Checkout',
  with_checkout: 'With Checkout',
  completed: 'Completed',
  cancelled: 'Cancelled / No-Show',
};

const ACTION_LABEL = {
  ready_for_assistant: 'Checked In',
  assign_operatory: 'Assigned Operatory',
  waiting_hygiene: 'Waiting for Hygienist',
  with_hygiene: 'With Hygienist',
  waiting_doctor: 'Waiting for Doctor',
  with_doctor: 'With Doctor',
  waiting_tc: 'Waiting for Treatment Coordinator',
  with_tc: 'With Treatment Coordinator',
  waiting_checkout: 'Ready for Checkout',
  with_checkout: 'With Checkout',
  complete: 'Completed Visit',
  manual_edit: 'Manual Edit',
  cancel_visit: 'Cancelled / No-Show',
};

// Used by the manual-edit (override) endpoint: if staff jump a visit
// straight to one of these statuses, this is the gap that should start.
const GAP_FOR_STATUS = {
  waiting_assistant: { number: 1, waitingFor: 'assistant' },
  waiting_hygiene: { number: 2, waitingFor: 'hygienist' },
  waiting_doctor: { number: 3, waitingFor: 'doctor' },
  waiting_tc: { number: 4, waitingFor: 'treatment_coordinator' },
  waiting_checkout: { number: 5, waitingFor: 'checkout' },
};

module.exports = {
  TRANSITIONS,
  NEXT_ACTION,
  TC_NEXT_ACTION,
  WAITING_STATUSES,
  STATIONS,
  STATUS_LABEL,
  ACTION_LABEL,
  GAP_FOR_STATUS,
};
