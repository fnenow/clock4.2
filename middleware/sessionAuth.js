function requireAdminLogin(req, res, next) {
  if (req.session && req.session.admin) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Admin login required"
  });
}

function requireWorkerLogin(req, res, next) {
  if (req.session && req.session.worker_id) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Worker login required"
  });
}

function requireAnyLogin(req, res, next) {
  if (req.session && (req.session.admin || req.session.worker_id)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Login required"
  });
}

module.exports = {
  requireAdminLogin,
  requireWorkerLogin,
  requireAnyLogin
};
