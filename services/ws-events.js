const WS_EVENTS = {
  INIT: 'init',
  LICENSE_INVALID: 'license_invalid',
  QUOTA_UPDATE: 'quota_update',
  ACCOUNT_SWITCH: 'account_switch',
  ALL_EXHAUSTED: 'all_exhausted',
  JOB_QUEUED: 'job_queued',
  JOB_START: 'job_start',
  JOB_REPLY: 'job_reply',
  JOB_PROGRESS: 'job_progress',
  JOB_DONE: 'job_done',
  JOB_ERROR: 'job_error',
  AUTO_LOGIN_PROGRESS: 'auto_login_progress',
  IMPORT_PROGRESS: 'import_progress'
};

module.exports = { WS_EVENTS };
