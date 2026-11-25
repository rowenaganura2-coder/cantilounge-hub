-- CantiLounge Hub schema for XAMPP (MySQL 8 / MariaDB 10.4+).
-- Verified with the local XAMPP MariaDB 10.4.32 server.
-- Re-importing upgrades the older XAMPP schema without deleting application rows.
-- Create the first ADMIN through the app; this file intentionally seeds no PINs.
CREATE DATABASE IF NOT EXISTS cantilounge_hub
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cantilounge_hub;

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  staff_code VARCHAR(16) NOT NULL UNIQUE,
  full_name VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('OWNER','ADMIN','MANAGER','CASHIER','BARISTA','KITCHEN') NOT NULL,
  face_descriptor JSON NULL,
  hourly_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_roles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  role ENUM('OWNER','ADMIN','MANAGER','CASHIER','BARISTA','KITCHEN') NOT NULL,
  UNIQUE KEY user_roles_user_role_uq (user_id, role),
  CONSTRAINT user_roles_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE OR REPLACE VIEW staff_profiles AS
  SELECT id, full_name, staff_code, hourly_rate, is_active, created_at FROM users;

CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ingredients (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  unit VARCHAR(24) NOT NULL,
  cost_per_unit DECIMAL(10,4) NOT NULL DEFAULT 0,
  current_stock DECIMAL(10,2) NOT NULL DEFAULT 0,
  min_threshold DECIMAL(10,2) NOT NULL DEFAULT 0,
  reorder_level DECIMAL(10,2) NOT NULL DEFAULT 0,
  expires_at DATE NULL,
  low_stock_notified_at TIMESTAMP(3) NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS menu_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  category_id CHAR(36) NOT NULL,
  base_price DECIMAL(10,2) NOT NULL,
  target_station ENUM('BARISTA','KITCHEN') NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  image_url TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT menu_items_category_fk FOREIGN KEY (category_id)
    REFERENCES categories(id) ON DELETE RESTRICT,
  INDEX menu_items_category_idx (category_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id CHAR(36) NOT NULL PRIMARY KEY,
  menu_item_id CHAR(36) NOT NULL,
  ingredient_id CHAR(36) NOT NULL,
  quantity_req DECIMAL(10,2) NOT NULL,
  UNIQUE KEY recipe_item_ingredient_uq (menu_item_id, ingredient_id),
  CONSTRAINT recipe_menu_item_fk FOREIGN KEY (menu_item_id)
    REFERENCES menu_items(id) ON DELETE CASCADE,
  CONSTRAINT recipe_ingredient_fk FOREIGN KEY (ingredient_id)
    REFERENCES ingredients(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  client_id CHAR(36) NOT NULL UNIQUE,
  order_number BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  order_type ENUM('DINE_IN','TAKEOUT','ADVANCE') NOT NULL,
  status ENUM('PENDING','IN_PREP','READY','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  customer_name VARCHAR(120) NULL,
  table_number VARCHAR(40) NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  discount_type VARCHAR(24) NULL,
  discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  cashier_id CHAR(36) NOT NULL,
  created_offline BOOLEAN NOT NULL DEFAULT FALSE,
  payment_method ENUM('UNPAID','CASH','GCASH','SPLIT') NOT NULL DEFAULT 'UNPAID',
  cash_received DECIMAL(10,2) NOT NULL DEFAULT 0,
  gcash_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  gcash_reference VARCHAR(13) NULL,
  payment_reference VARCHAR(64) NULL,
  settled_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT orders_cashier_fk FOREIGN KEY (cashier_id) REFERENCES users(id),
  INDEX orders_status_created_idx (status, created_at),
  INDEX orders_settled_idx (settled_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id CHAR(36) NOT NULL PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  menu_item_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  station ENUM('BARISTA','KITCHEN') NOT NULL,
  quantity INT NOT NULL,
  modifiers JSON NULL,
  item_price DECIMAL(10,2) NOT NULL,
  item_status ENUM('PENDING','IN_PREP','READY','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT order_items_menu_fk FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
  CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  INDEX order_items_order_idx (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  ingredient_id CHAR(36) NOT NULL,
  `change` DECIMAL(10,2) NOT NULL,
  reason VARCHAR(80) NOT NULL,
  order_id CHAR(36) NULL,
  user_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT stock_transactions_ingredient_fk FOREIGN KEY (ingredient_id)
    REFERENCES ingredients(id),
  CONSTRAINT stock_transactions_order_fk FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT stock_transactions_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX stock_transactions_ingredient_created_idx (ingredient_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attendance_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  clock_in TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  clock_out TIMESTAMP(3) NULL,
  override_by CHAR(36) NULL,
  break_minutes INT NOT NULL DEFAULT 0,
  total_hours DECIMAL(5,2) NULL,
  overtime_min INT NOT NULL DEFAULT 0,
  is_late BOOLEAN NOT NULL DEFAULT FALSE,
  verification_method ENUM('MANUAL','FACE_ID','PIN_OVERRIDE') NOT NULL DEFAULT 'MANUAL',
  notes TEXT NULL,
  CONSTRAINT attendance_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT attendance_override_fk FOREIGN KEY (override_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX attendance_user_clock_idx (user_id, clock_in)
) ENGINE=InnoDB;

SET @column_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ingredients'
    AND COLUMN_NAME = 'low_stock_notified_at'
);
SET @ddl = IF(
  @column_exists = 0,
  'ALTER TABLE ingredients ADD COLUMN low_stock_notified_at TIMESTAMP(3) NULL AFTER expires_at',
  'DO 0'
);
PREPARE add_ingredients_notification_column FROM @ddl;
EXECUTE add_ingredients_notification_column;
DEALLOCATE PREPARE add_ingredients_notification_column;

SET @column_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'attendance_logs'
    AND COLUMN_NAME = 'override_by'
);
SET @ddl = IF(
  @column_exists = 0,
  'ALTER TABLE attendance_logs ADD COLUMN override_by CHAR(36) NULL AFTER clock_out',
  'DO 0'
);
PREPARE add_attendance_override_column FROM @ddl;
EXECUTE add_attendance_override_column;
DEALLOCATE PREPARE add_attendance_override_column;

SET @constraint_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'attendance_logs'
    AND CONSTRAINT_NAME = 'attendance_override_fk'
);
SET @ddl = IF(
  @constraint_exists = 0,
  'ALTER TABLE attendance_logs ADD CONSTRAINT attendance_override_fk FOREIGN KEY (override_by) REFERENCES users(id) ON DELETE SET NULL',
  'DO 0'
);
PREPARE add_attendance_override_fk FROM @ddl;
EXECUTE add_attendance_override_fk;
DEALLOCATE PREPARE add_attendance_override_fk;

CREATE TABLE IF NOT EXISTS staff_face_descriptors (
  user_id CHAR(36) NOT NULL PRIMARY KEY,
  descriptor JSON NOT NULL,
  enrolled_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT staff_face_descriptors_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  actor_user_id CHAR(36) NULL,
  actor_role VARCHAR(16) NOT NULL DEFAULT 'SYSTEM',
  action_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(64) NULL,
  entity_label VARCHAR(160) NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT audit_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX audit_created_at_idx (created_at),
  INDEX audit_entity_idx (entity_type, entity_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_audit_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  employee_id CHAR(36) NOT NULL,
  action ENUM('MODIFY','VOID','SETTLE','COMPLETE') NOT NULL,
  reason TEXT NULL,
  before_state JSON NOT NULL,
  after_state JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT order_audit_order_fk FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT order_audit_employee_fk FOREIGN KEY (employee_id) REFERENCES users(id),
  INDEX order_audit_order_created_idx (order_id, created_at)
) ENGINE=InnoDB;

INSERT INTO categories (id, name, sort_order)
SELECT UUID(), seed.name, seed.sort_order
FROM (
  SELECT 'Espresso Bar' AS name, 1 AS sort_order
  UNION ALL SELECT 'Signature', 2
  UNION ALL SELECT 'Non-Coffee', 3
  UNION ALL SELECT 'Kitchen', 4
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM categories AS existing WHERE existing.name = seed.name
);

INSERT INTO ingredients (
  id, name, unit, cost_per_unit, current_stock, min_threshold, reorder_level
)
SELECT
  UUID(), seed.name, seed.unit, seed.cost_per_unit, seed.current_stock,
  seed.min_threshold, seed.min_threshold
FROM (
  SELECT 'Espresso Beans' AS name, 'g' AS unit, 1.2000 AS cost_per_unit, 5000 AS current_stock, 1000 AS min_threshold
  UNION ALL SELECT 'Fresh Milk', 'ml', 0.0900, 20000, 4000
  UNION ALL SELECT 'Oat Milk', 'ml', 0.1800, 6000, 1500
  UNION ALL SELECT 'Matcha Powder', 'g', 3.5000, 800, 200
  UNION ALL SELECT 'Caramel Syrup', 'ml', 0.4000, 2000, 400
  UNION ALL SELECT 'Vanilla Syrup', 'ml', 0.4000, 2000, 400
  UNION ALL SELECT 'Dark Chocolate', 'g', 0.8000, 1500, 300
  UNION ALL SELECT 'Sourdough Bread', 'pcs', 18.0000, 40, 10
  UNION ALL SELECT 'Eggs', 'pcs', 9.0000, 120, 24
  UNION ALL SELECT 'Butter', 'g', 0.6000, 2000, 400
  UNION ALL SELECT 'Croissant Dough', 'pcs', 22.0000, 30, 8
  UNION ALL SELECT 'Ham', 'g', 0.9000, 1500, 300
  UNION ALL SELECT 'Cheese', 'g', 0.8000, 1500, 300
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM ingredients AS existing WHERE existing.name = seed.name
);

INSERT INTO menu_items (id, name, category_id, base_price, target_station)
SELECT UUID(), seed.name, categories.id, seed.base_price, seed.target_station
FROM (
  SELECT 'Espresso' AS name, 'Espresso Bar' AS category_name, 110 AS base_price, 'BARISTA' AS target_station
  UNION ALL SELECT 'Americano', 'Espresso Bar', 130, 'BARISTA'
  UNION ALL SELECT 'Cafe Latte', 'Espresso Bar', 160, 'BARISTA'
  UNION ALL SELECT 'Cappuccino', 'Espresso Bar', 160, 'BARISTA'
  UNION ALL SELECT 'Spanish Latte', 'Signature', 180, 'BARISTA'
  UNION ALL SELECT 'Salted Caramel Macchiato', 'Signature', 190, 'BARISTA'
  UNION ALL SELECT 'Canti Mocha', 'Signature', 185, 'BARISTA'
  UNION ALL SELECT 'Matcha Latte', 'Non-Coffee', 180, 'BARISTA'
  UNION ALL SELECT 'Hot Chocolate', 'Non-Coffee', 150, 'BARISTA'
  UNION ALL SELECT 'Butter Croissant', 'Kitchen', 120, 'KITCHEN'
  UNION ALL SELECT 'Ham & Cheese Croissant', 'Kitchen', 190, 'KITCHEN'
  UNION ALL SELECT 'Egg Sourdough Toast', 'Kitchen', 210, 'KITCHEN'
) AS seed
JOIN categories ON categories.name = seed.category_name
WHERE NOT EXISTS (
  SELECT 1 FROM menu_items AS existing WHERE existing.name = seed.name
);

UPDATE menu_items
SET image_url = CASE name
  WHEN 'Espresso' THEN '/menu-images/expre.jpg'
  WHEN 'Americano' THEN '/menu-images/americano.jpg'
  WHEN 'Cafe Latte' THEN '/menu-images/cafe%20latte.jpg'
  WHEN 'Cappuccino' THEN '/menu-images/capu.jpg'
  WHEN 'Spanish Latte' THEN '/menu-images/spanish.jpg'
  WHEN 'Salted Caramel Macchiato' THEN '/menu-images/sal%20car.jpg'
  WHEN 'Canti Mocha' THEN '/menu-images/mocha.jpg'
  WHEN 'Matcha Latte' THEN '/menu-images/matcha.webp'
  WHEN 'Hot Chocolate' THEN '/menu-images/choco.jpg'
  WHEN 'Butter Croissant' THEN '/menu-images/croisant.webp'
  WHEN 'Ham & Cheese Croissant' THEN '/menu-images/ham.jpg'
  WHEN 'Egg Sourdough Toast' THEN '/menu-images/sour.jpg'
  ELSE image_url
END
WHERE (
    image_url IS NULL
    OR image_url = ''
    OR image_url IN (
    '/menu-images/espresso.jpg',
    '/menu-images/americano.jpg',
    '/menu-images/cafe-latte.jpg',
    '/menu-images/cappuccino.jpg',
    '/menu-images/spanish-latte.jpg',
    '/menu-images/salted-caramel-macchiato.jpg',
    '/menu-images/canti-mocha.jpg'
    )
  )
  AND name IN (
    'Espresso',
    'Americano',
    'Cafe Latte',
    'Cappuccino',
    'Spanish Latte',
    'Salted Caramel Macchiato',
    'Canti Mocha',
    'Matcha Latte',
    'Hot Chocolate',
    'Butter Croissant',
    'Ham & Cheese Croissant',
    'Egg Sourdough Toast'
  );

INSERT INTO recipe_ingredients (id, menu_item_id, ingredient_id, quantity_req)
SELECT UUID(), menu_items.id, ingredients.id, seed.quantity_req
FROM (
  SELECT 'Espresso' AS menu_name, 'Espresso Beans' AS ingredient_name, 18 AS quantity_req
  UNION ALL SELECT 'Americano', 'Espresso Beans', 18
  UNION ALL SELECT 'Cafe Latte', 'Espresso Beans', 18
  UNION ALL SELECT 'Cafe Latte', 'Fresh Milk', 220
  UNION ALL SELECT 'Cappuccino', 'Espresso Beans', 18
  UNION ALL SELECT 'Cappuccino', 'Fresh Milk', 160
  UNION ALL SELECT 'Spanish Latte', 'Espresso Beans', 18
  UNION ALL SELECT 'Spanish Latte', 'Fresh Milk', 200
  UNION ALL SELECT 'Spanish Latte', 'Vanilla Syrup', 20
  UNION ALL SELECT 'Salted Caramel Macchiato', 'Espresso Beans', 18
  UNION ALL SELECT 'Salted Caramel Macchiato', 'Fresh Milk', 200
  UNION ALL SELECT 'Salted Caramel Macchiato', 'Caramel Syrup', 25
  UNION ALL SELECT 'Canti Mocha', 'Espresso Beans', 18
  UNION ALL SELECT 'Canti Mocha', 'Fresh Milk', 200
  UNION ALL SELECT 'Canti Mocha', 'Dark Chocolate', 25
  UNION ALL SELECT 'Matcha Latte', 'Matcha Powder', 6
  UNION ALL SELECT 'Matcha Latte', 'Fresh Milk', 240
  UNION ALL SELECT 'Hot Chocolate', 'Dark Chocolate', 35
  UNION ALL SELECT 'Hot Chocolate', 'Fresh Milk', 240
  UNION ALL SELECT 'Butter Croissant', 'Croissant Dough', 1
  UNION ALL SELECT 'Butter Croissant', 'Butter', 10
  UNION ALL SELECT 'Ham & Cheese Croissant', 'Croissant Dough', 1
  UNION ALL SELECT 'Ham & Cheese Croissant', 'Ham', 40
  UNION ALL SELECT 'Ham & Cheese Croissant', 'Cheese', 30
  UNION ALL SELECT 'Egg Sourdough Toast', 'Sourdough Bread', 2
  UNION ALL SELECT 'Egg Sourdough Toast', 'Eggs', 2
  UNION ALL SELECT 'Egg Sourdough Toast', 'Butter', 15
) AS seed
JOIN menu_items ON menu_items.name = seed.menu_name
JOIN ingredients ON ingredients.name = seed.ingredient_name
WHERE NOT EXISTS (
  SELECT 1 FROM recipe_ingredients AS existing
  WHERE existing.menu_item_id = menu_items.id
    AND existing.ingredient_id = ingredients.id
);

DROP PROCEDURE IF EXISTS settle_order;
DROP TRIGGER IF EXISTS audit_logs_no_update;
DROP TRIGGER IF EXISTS audit_logs_no_delete;
DROP TRIGGER IF EXISTS order_audit_logs_no_update;
DROP TRIGGER IF EXISTS order_audit_logs_no_delete;

DELIMITER //
CREATE PROCEDURE settle_order(
  IN p_order_id CHAR(36),
  IN p_payment_method VARCHAR(8),
  IN p_cash_received DECIMAL(10,2),
  IN p_gcash_amount DECIMAL(10,2),
  IN p_gcash_reference VARCHAR(13),
  IN p_actor_user_id CHAR(36)
)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_total DECIMAL(10,2);
  DECLARE v_status VARCHAR(16);
  DECLARE v_role VARCHAR(16);
  DECLARE v_now TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT role INTO v_role FROM users
  WHERE id = p_actor_user_id AND is_active = TRUE;
  IF v_role IS NULL OR v_role NOT IN ('OWNER','ADMIN','MANAGER','CASHIER') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Forbidden';
  END IF;

  START TRANSACTION;
  SELECT total_amount, status INTO v_total, v_status
  FROM orders WHERE id = p_order_id FOR UPDATE;
  IF v_total IS NULL OR v_status IN ('COMPLETED','CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order cannot be settled';
  END IF;
  IF p_payment_method = 'CASH' THEN
    IF p_cash_received < v_total OR p_gcash_amount <> 0 OR p_gcash_reference IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cash received must cover the total';
    END IF;
  ELSEIF p_payment_method = 'GCASH' THEN
    IF p_cash_received <> 0 OR p_gcash_amount <> v_total
      OR (p_gcash_reference IS NOT NULL AND p_gcash_reference NOT REGEXP '^[0-9]{4,13}$') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'GCash amount or reference is invalid';
    END IF;
  ELSEIF p_payment_method = 'SPLIT' THEN
    IF p_cash_received < 0 OR p_gcash_amount <= 0
      OR p_cash_received + p_gcash_amount <> v_total
      OR (p_gcash_reference IS NOT NULL AND p_gcash_reference NOT REGEXP '^[0-9]{4,13}$') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Split tender must equal the total and use a valid GCash reference';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Select CASH, GCASH, or SPLIT';
  END IF;

  UPDATE orders
  SET payment_method = p_payment_method,
      cash_received = p_cash_received,
      gcash_amount = p_gcash_amount,
      gcash_reference = IF(p_payment_method IN ('GCASH','SPLIT'), p_gcash_reference, NULL),
      payment_reference = IF(p_payment_method IN ('GCASH','SPLIT'), p_gcash_reference, NULL),
      settled_at = v_now,
      status = 'COMPLETED'
  WHERE id = p_order_id;
  UPDATE order_items SET item_status = 'COMPLETED'
  WHERE order_id = p_order_id AND item_status <> 'CANCELLED';
  INSERT INTO order_audit_logs
    (id, order_id, employee_id, action, before_state, after_state, created_at)
  VALUES (
    UUID(), p_order_id, p_actor_user_id, 'SETTLE',
    JSON_OBJECT('status', v_status),
    JSON_OBJECT('payment_method', p_payment_method, 'settled_at', v_now),
    v_now
  );
  COMMIT;
END//

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable';
END//

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable';
END//

CREATE TRIGGER order_audit_logs_no_update
BEFORE UPDATE ON order_audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order audit logs are immutable';
END//

CREATE TRIGGER order_audit_logs_no_delete
BEFORE DELETE ON order_audit_logs
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order audit logs are immutable';
END//
DELIMITER ;
