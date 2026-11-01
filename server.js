const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let db;

// Inicializar Base de Datos y Ledger Contable
async function initDB() {
  db = await open({
    filename: './bank.sqlite',
    driver: sqlite3.Database
  });

  // Habilitar claves foráneas
  await db.run('PRAGMA foreign_keys = ON;');

  // Tabla de Cuentas Bancarias
  await db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      balance REAL NOT NULL CHECK(balance >= 0),
      is_locked INTEGER NOT NULL DEFAULT 0,
      card_number TEXT NOT NULL,
      cvv TEXT NOT NULL,
      exp_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      type TEXT CHECK(type IN ('credit', 'debit')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
  `);

  // Crear cuentas de prueba si no existen
  const userCheck = await db.get('SELECT COUNT(*) as count FROM accounts');
  if (userCheck.count === 0) {
    await db.run(`
      INSERT INTO accounts (name, email, balance, card_number, cvv, exp_date)
      VALUES 
      ('Juan Delgado', 'juan@novabank.com', 12500.00, '4152 8821 9923 8492', '482', '09/28'),
      ('Maria Lopez', 'maria@gmail.com', 4300.00, '4152 7712 3341 1102', '109', '11/27')
    `);

    // Movimiento inicial de Juan (id: 1)
    await db.run(`
      INSERT INTO transactions (account_id, type, title, description, amount)
      VALUES (1, 'credit', 'Abono de Nómina', 'Depósito Empleador S.A.', 12500.00)
    `);
  }
}

// ---------------- ENDPOINTS API ---------------- //

// 1. Obtener datos de la cuenta actual (simulado con id = 1)
app.get('/api/account', async (req, res) => {
  try {
    const account = await db.get('SELECT id, name, email, balance, is_locked, card_number, cvv, exp_date FROM accounts WHERE id = 1');
    const transactions = await db.all('SELECT * FROM transactions WHERE account_id = 1 ORDER BY id DESC LIMIT 20');
    res.json({ account, transactions });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar la cuenta' });
  }
});

// 2. Transferencia Transaccional ACID (Doble partida contable)
app.post('/api/transfer', async (req, res) => {
  const { recipientEmail, concept, amount } = req.body;
  const numAmount = parseFloat(amount);
  const senderId = 1; // Sesión activa

  if (!recipientEmail || !concept || isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Datos de transferencia inválidos' });
  }

  // INICIO DE LA TRANSACCIÓN ATÓMICA
  await db.run('BEGIN TRANSACTION');

  try {
    // 1. Validar remitente
    const sender = await db.get('SELECT * FROM accounts WHERE id = ?', [senderId]);
    if (!sender) throw new Error('Cuenta remitente no encontrada');
    if (sender.is_locked) throw new Error('Tu cuenta/tarjeta se encuentra bloqueada');
    if (sender.balance < numAmount) throw new Error('Saldo insuficiente para completar la operación');

    // 2. Validar destinatario
    const recipient = await db.get('SELECT * FROM accounts WHERE email = ?', [recipientEmail]);
    if (!recipient) throw new Error(`El destinatario "${recipientEmail}" no está registrado`);
    if (recipient.id === sender.id) throw new Error('No puedes transferirte a tu propia cuenta');

    // 3. Ejecutar débito y crédito
    await db.run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [numAmount, sender.id]);
    await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [numAmount, recipient.id]);

    // 4. Registrar en el libro contable de transacciones
    await db.run(`
      INSERT INTO transactions (account_id, type, title, description, amount)
      VALUES (?, 'debit', ?, ?, ?)
    `, [sender.id, concept, `Para: ${recipient.name} (${recipient.email})`, numAmount]);

    await db.run(`
      INSERT INTO transactions (account_id, type, title, description, amount)
      VALUES (?, 'credit', ?, ?, ?)
    `, [recipient.id, concept, `De: ${sender.name} (${sender.email})`, numAmount]);

    // CONFIRMAR TRANSACCIÓN
    await db.run('COMMIT');
    res.json({ success: true, message: 'Transferencia realizada con éxito' });

  } catch (error) {
    // REVERTIR CAMBIOS EN CASO DE CUALQUIER FALLO
    await db.run('ROLLBACK');
    res.status(400).json({ error: error.message });
  }
});

// 3. Depósito de fondos
app.post('/api/deposit', async (req, res) => {
  const { amount } = req.body;
  const numAmount = parseFloat(amount);
  const accountId = 1;

  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'Monto de depósito inválido' });
  }

  await db.run('BEGIN TRANSACTION');
  try {
    await db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [numAmount, accountId]);
    await db.run(`
      INSERT INTO transactions (account_id, type, title, description, amount)
      VALUES (?, 'credit', 'Ingreso de Fondos', 'Depósito Directo / SPEI', ?)
    `, [accountId, numAmount]);

    await db.run('COMMIT');
    res.json({ success: true, message: 'Fondos ingresados correctamente' });
  } catch (error) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: 'Fallo al procesar el depósito' });
  }
});

// 4. Bloquear / Desbloquear Tarjeta
app.post('/api/toggle-lock', async (req, res) => {
  try {
    const account = await db.get('SELECT is_locked FROM accounts WHERE id = 1');
    const newState = account.is_locked ? 0 : 1;
    await db.run('UPDATE accounts SET is_locked = ? WHERE id = 1', [newState]);
    res.json({ success: true, is_locked: newState });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar estado' });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Core Bancario activo en: http://localhost:${PORT}`);
  });
});