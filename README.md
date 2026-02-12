# Google Meet Roll Call Extractor

A powerful Chrome extension designed to streamline attendance taking in Google Meet. It automatically extracts student names and their roll numbers from the chat, filters out the meeting host, and provides a comprehensive CSV download.

## 🚀 Features

- **Automated Extraction**: Scans the chat for roll numbers and associates them with the sender's name.
- **Smart Filtering**: Automatically attempts to identify and exclude the meeting host from the attendance list.
- **Duplicate Handling**: Handles cases where a student sends their roll number multiple times or sends multiple numbers.
- **CSV Export**: Downloads a clean, sorted CSV file containing:
  - Serial Number
  - Student Name (Sorted)
  - Roll Number(s)
  - **Notes Column**: Flags students who have entered multiple different roll numbers.
  - **Bulk List**: A comma-separated list of all roll numbers in the first row for easy copying.
- **Auto-Open Chat**: If the chat sidebar is closed, the extension automatically opens it to ensure all latest messages are captured before downloading.
- **Privacy Focused**: Runs entirely locally in your browser. No data is sent to external servers.

## 📥 Installation Guide

1.  **Download the Code**:
    - Clone this repository or download the ZIP file and extract it to a folder on your computer.

2.  **Open Chrome Extensions**:
    - Open Google Chrome (or Microsoft Edge/Brave).
    - Navigate to `chrome://extensions` in the address bar.

3.  **Enable Developer Mode**:
    - Toggle the **"Developer mode"** switch in the top-right corner of the Extensions page.

4.  **Load the Extension**:
    - Click the **"Load unpacked"** button.
    - Select the folder where you saved/extracted the extension files (the folder containing `manifest.json`).

5.  **Pin it (Optional)**:
    - The extension works automatically on Google Meet, but you can pin it for easy access to permissions if needed.

## 🛠️ How to Use

1.  **Join a Google Meet**: Start or join your class/meeting as usual.
2.  **Wait for Roll Calls**: Ask students to type their roll numbers in the chat box.
    - _Note: It's best practice to keep the chat open, but the extension will try to open it if you forgot._
3.  **Click the button**:
    - Look for the **Blue Circle Button** with a checkmark icon in the bottom-left corner of the screen.
    - Click it.
4.  **Download Attendance**:
    - The extension will scan the chat, process the data, and automatically download a file named `MeetingName_Attendance_YYYY-MM-DD.csv`.

## 📄 Output Format

The downloaded CSV file contains the following columns:

| Column                      | Description                                                                                                          |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| **Serial No.**              | A simple counter (1, 2, 3...)                                                                                        |
| **Student Name**            | The name of the attendee as it appears in Google Meet.                                                               |
| **Roll Number**             | The extracted roll number(s).                                                                                        |
| **Notes**                   | Warnings (e.g., "⚠️ Multiple Rolls Found") if a student entered conflicting data.                                    |
| **All Roll Numbers (Bulk)** | (In the first row only) A compiled, sorted list of **all** roll numbers present in the meeting, separated by commas. |

## 🤝 Contributing

Feel free to fork this project and submit pull requests if you have ideas for improvements!
