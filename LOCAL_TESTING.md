# Tymczasowy tryb lokalnych testów anonimowych

Tryb istnieje wyłącznie do testów lokalnych. Włącza się automatycznie na `localhost` lub `127.0.0.1`. W tej konfiguracji aplikacja pokazuje przycisk **Wejdź jako tester**, używa projektu emulatora `demo-splendor-local` i łączy Authentication, Cloud Firestore oraz Realtime Database z lokalnym Firebase Emulator Suite. Nie używa produkcyjnego projektu Firebase. Na GitHub Pages tryb jest wyłączony, bo domena strony nie jest lokalna.

## Uruchomienie

Wymagane są Node.js 16+, Firebase CLI i JDK 21. Zainstalowana tutaj Firebase CLI 15.33.0 wymaga JDK 21. W tym środowisku przygotowano Node.js 22, Firebase CLI 15.33.0 i Eclipse Temurin JDK 21.

1. W terminalu PowerShell w katalogu projektu ustaw JDK 21 i uruchom emulatory:

   ```powershell
   $env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
   $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
   firebase emulators:start --only auth,firestore,database --project demo-splendor-local
   ```

   Emulator pobiera reguły z istniejących `firestore.rules` i `database.rules.json`. Nie uruchamiaj emulatorów na prawdziwym ID projektu Firebase.
2. W drugim terminalu, również w katalogu projektu, uruchom serwer strony:

   ```powershell
   python -m http.server 8765
   ```

3. Otwórz `http://127.0.0.1:8765/`. Wybierz **Wejdź jako tester**. Każda osobna karta przeglądarki dostaje własną sesję anonimową; zaproś kolejne karty linkiem z lobby.
4. Zatrzymaj oba procesy przez `Ctrl+C`. Emulator przechowuje dane w pamięci, więc po zatrzymaniu partii testowe znikają.

Jeżeli emulator nie działa, logowanie i operacje Firestore/Realtime Database zakończą się błędem zamiast przełączyć się na produkcję. Trybu lokalnego nie da się włączyć samym parametrem URL na domenie publicznej.

## Cofnięcie

W nowym czacie można poprosić: **„Cofnij tymczasowy lokalny tryb anonimowych testów opisany w `LOCAL_TESTING.md`. Zachowaj wszystkie pozostałe lokalne zmiany.”** Tryb obejmuje tylko jego zmiany w `firebase-client.js`, `game.js`, `game-engine.js`, `game.css` oraz fragmenty uwierzytelniania w `index.html`, a także ten plik. Nie przywracaj całych plików z Git, bo mogą zawierać niezależne zmiany. `firebase-config.js`, reguły, produkcyjny projekt Firebase i pozostałe funkcje nie są zmieniane przez ten tryb.
