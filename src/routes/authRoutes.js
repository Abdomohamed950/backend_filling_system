const express = require("express");
const router = express.Router();
const authController = require("../controllers/authControllers");

router.post("/auth/login", authController.login);
router.get("/auth/me", authController.me);
router.post("/auth/logout", authController.logout);

module.exports = router;
