const Operator = require("../models/operatorModel");

// UNIQUE على operator.code و operator.username — رسالة better-sqlite3 بصيغة
// "UNIQUE constraint failed: operator.username"، نستخرج منها اسم الحقل
// لرد 409 واضح بدل 500 عام.
function uniqueField(error) {
  if (error.code !== "SQLITE_CONSTRAINT_UNIQUE") return null;
  const match = /operator\.(\w+)/.exec(error.message);
  return match ? match[1] : "field";
}

const OperatorController = {
  // إنشاء مستخدم جديد
  createOperator: async (req, res) => {
    try {
      const { name, code, pass, phone, username, role } = req.body;
      console.log(req.body);
      if (!name || !code || !pass || !phone) {
        return res.status(400).json({
          error: "Name, code, pass, and phone are required",
        });
      }

      const newOperator = await Operator.create({
        name,
        code,
        pass,
        phone,
        username,
        role,
      });
      res.status(201).json({
        message: "Operator created successfully",
        Operator: newOperator,
      });
    } catch (error) {
      const field = uniqueField(error);
      if (field) {
        return res
          .status(409)
          .json({ error: `${field} "${req.body[field]}" is already in use` });
      }
      console.error("Error creating Operator:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // الحصول على جميع المستخدمين
  getOperators: async (req, res) => {
    try {
      const Operators = await Operator.findAll();
      res.json(Operators);
    } catch (error) {
      console.error("Error fetching Operators:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // الحصول على مستخدم بواسطة ID
  getOperatorById: async (req, res) => {
    try {
      const { id } = req.params;
      const operator = await Operator.findById(id);

      if (!operator) {
        return res.status(404).json({ error: "Operator not found" });
      }

      res.json(operator);
    } catch (error) {
      console.error("Error fetching Operator:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // تحديث مستخدم
  updateOperator: async (req, res) => {
    try {
      const { id } = req.params;
      const { name, code, pass, phone, username, role } = req.body;

      const existingOperator = await Operator.findById(id);
      if (!existingOperator) {
        return res.status(404).json({ error: "Operator not found" });
      }

      const updatedOperator = await Operator.update(id, {
        name,
        code,
        pass,
        phone,
        username,
        role,
      });
      res.json({
        message: "Operator updated successfully",
        Operator: updatedOperator,
      });
    } catch (error) {
      const field = uniqueField(error);
      if (field) {
        return res
          .status(409)
          .json({ error: `${field} "${req.body[field]}" is already in use` });
      }
      console.error("Error updating Operator:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // حذف مستخدم
  deleteOperator: async (req, res) => {
    try {
      const { id } = req.params;

      const existingOperator = await Operator.findById(id);
      if (!existingOperator) {
        return res.status(404).json({ error: "Operator not found" });
      }

      const deletedOperator = await Operator.delete(id);
      res.json({
        message: "Operator deleted successfully",
        Operator: deletedOperator,
      });
    } catch (error) {
      console.error("Error deleting Operator:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = OperatorController;
