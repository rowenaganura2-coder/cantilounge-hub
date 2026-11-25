@echo off
title Cantilounge Hub - Automated Local Setup
echo ===================================================
echo   Cantilounge Hub - Localhost Setup & Launcher
echo ===================================================

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js LTS first.
    pause
    exit /b 1
)

:: 2. Create .env from .env.example if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [OK] Created .env from .env.example
    )
)

:: 3. Install dependencies
echo [1/3] Installing npm dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

:: 4. Import XAMPP SQL database if XAMPP MySQL is available
if exist "C:\xampp\mysql\bin\mysql.exe" (
    echo [2/3] Setting up cantilounge_hub database in XAMPP...
    C:\xampp\mysql\bin\mysql.exe -u root -e "CREATE DATABASE IF NOT EXISTS cantilounge_hub;"
    if exist "cantilounge_xampp.sql" (
        C:\xampp\mysql\bin\mysql.exe -u root cantilounge_hub < cantilounge_xampp.sql
        echo [OK] Imported cantilounge_xampp.sql
    )
) else (
    echo [WARNING] XAMPP not detected at C:\xampp. Please import cantilounge_xampp.sql into MySQL manually.
)

:: 5. Build and start the app
echo [3/3] Building and starting Cantilounge Hub...
call npm run build
start "" "http://localhost:8080"
call node scripts/start.mjs
pause