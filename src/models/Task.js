const mongoose = require("mongoose");

/**
 * A personal to-do item pinned to one calendar day.
 *
 * `date` is stored as a plain "YYYY-MM-DD" business-date string rather than a
 * Date. A task written for the 5th must stay on the 5th no matter which
 * timezone the server or the browser is in — storing a Date would let UTC
 * conversion slide it a day either way.
 */
const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // denormalised so an admin day-view does not need a populate per row
    userName: { type: String, trim: true, default: "" },

    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    // optional "HH:mm" — tasks with a time sort above those without
    time: { type: String, trim: true, default: "" },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    note: { type: String, trim: true, default: "", maxlength: 2000 },

    priority: {
      type: String,
      enum: ["low", "normal", "high"],
      default: "normal",
      index: true,
    },

    done: { type: Boolean, default: false, index: true },
    doneAt: { type: Date, default: null },

    // optional link back to an enquiry ("call this client back on Friday")
    leadId: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "tasks" }
);

// the two queries this collection actually serves
taskSchema.index({ userId: 1, date: 1 });
taskSchema.index({ date: 1, done: 1 });

module.exports = mongoose.model("Task", taskSchema);
