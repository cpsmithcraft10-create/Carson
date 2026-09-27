'use strict';

/**
 * Parts going on and off a worksheet.
 *
 * The crew add these standing in a trench and the office add them reading a
 * receipt, so both sides come through here rather than each writing their own
 * version of the same three lines.
 */

const v = require('./validate');
const { HttpError } = require('./http');
const { loadSheet } = require('./queries');

function addPart(db, jobId, body, byWho) {
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new HttpError(404, 'No such worksheet');

  const item = v.text(body.item, 'What it was', { required: true, max: 160 });
  const unit = v.text(body.unit, 'How it is measured', { max: 24 });

  // A part somebody did not put a number against is one of it, which is what
  // they meant. Nought of something is not.
  const quantity = body.quantity == null || body.quantity === ''
    ? 1
    : v.decimal(body.quantity, 'How many', { min: 0, max: 100000, fallback: 1 });
  if (!(quantity > 0)) v.fail('How many has to be more than nothing');

  db.prepare(`
    INSERT INTO materials (job_id, item, quantity, unit, added_by) VALUES (?, ?, ?, ?, ?)
  `).run(jobId, item, quantity, unit, byWho);

  return loadSheet(db, jobId);
}

function dropPart(db, jobId, partId) {
  // Scoped to the job, so a part id from another sheet cannot be used to
  // reach into one somebody is not looking at.
  const gone = db.prepare('DELETE FROM materials WHERE id = ? AND job_id = ?')
    .run(partId, jobId);
  if (gone.changes === 0) throw new HttpError(404, 'That part was not on this worksheet');

  return loadSheet(db, jobId);
}

module.exports = { addPart, dropPart };
