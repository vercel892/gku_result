-- =============================================================
-- GKU RESULT MANAGEMENT SYSTEM — DATABASE SETUP
-- Guru Kashi University, Talwandi Sabo, Bathinda, Punjab
-- =============================================================
--
-- STEP 1: Create the database (run in psql as postgres user)
--   psql -U postgres -c "CREATE DATABASE gku_db;"
--
-- STEP 2: Run this file against gku_db
--   psql -U postgres -d gku_db -f setup_db.sql
-- =============================================================

-- ==================== STUDENTS TABLE ====================
CREATE TABLE IF NOT EXISTS students (
    id          SERIAL PRIMARY KEY,
    roll_no     VARCHAR(60)  UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name        VARCHAR(150) NOT NULL,
    father_name VARCHAR(150),
    mother_name VARCHAR(150),
    course      VARCHAR(100),
    branch      VARCHAR(120),
    batch_year  VARCHAR(20),
    email       VARCHAR(120),
    phone       VARCHAR(15),
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
);

-- ==================== RESULTS TABLE ====================
CREATE TABLE IF NOT EXISTS results (
    id              SERIAL PRIMARY KEY,
    student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    semester        INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 6),
    result_type     VARCHAR(10) NOT NULL DEFAULT 'marks'
                        CHECK (result_type IN ('marks', 'pdf')),
    -- For marks-type results
    subjects        JSONB,
    -- Each subject object: { subject, max_marks, passing_marks, obtained, grade }
    total_marks     INTEGER,
    obtained_marks  INTEGER,
    percentage      DECIMAL(5, 2),
    -- For pdf-type results
    pdf_path        VARCHAR(300),
    -- Common fields
    result_status   VARCHAR(20) DEFAULT 'Pass'
                        CHECK (result_status IN ('Pass','Fail','Withheld','Absent','Result Awaited')),
    exam_session    VARCHAR(60),   -- e.g. "Nov/Dec 2024"
    declaration_date DATE,
    remarks         TEXT,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE (student_id, semester)
);

-- ==================== ADMINS TABLE ====================
CREATE TABLE IF NOT EXISTS admins (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(60) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(150),
    created_at    TIMESTAMP DEFAULT NOW()
);

-- ==================== INDEXES ====================
CREATE INDEX IF NOT EXISTS idx_students_roll_no  ON students (LOWER(roll_no));
CREATE INDEX IF NOT EXISTS idx_results_student   ON results (student_id);
CREATE INDEX IF NOT EXISTS idx_results_semester  ON results (semester);

-- ==================== UPDATED_AT TRIGGER ====================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_students_updated_at ON students;
CREATE TRIGGER tg_students_updated_at
    BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS tg_results_updated_at ON results;
CREATE TRIGGER tg_results_updated_at
    BEFORE UPDATE ON results
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ==================== STATUS ====================
SELECT 'GKU Result System database schema created successfully!' AS status;
-- NOTE: Default admin (admin / admin123) is auto-created by server.js on first startup.
