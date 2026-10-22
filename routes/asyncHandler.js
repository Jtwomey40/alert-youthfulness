// Wraps an async Express handler so a rejected promise (e.g. a DB error)
// is forwarded to next(err) instead of crashing the process.
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
