# Classroom mode

One shared board where each student draws only in a frame of their own. The teacher sees the whole class on one
canvas, and can reveal everything at once with private mode.

## How a class uses it

1. **The teacher prepares frames.** Draw a frame with the activity in it (a worksheet, a question), select it, and use
   **Make copies** in its panel to get one per student (up to 60 at once). The copies go in rows beside the board,
   named "Worksheet 1", "Worksheet 2", and so on.
2. **The teacher shares the board** with an "anyone can edit" link and starts classroom mode from the graduation-cap
   button at the bottom right. A notice under the toolbar counts the frames claimed.
3. **Each student claims a frame.** They open the link and click an empty frame. A guest gives the name to show on it.
   Their frame is outlined and labelled "You", other frames show who claimed them, and **Go to it** brings theirs
   back into view.
4. **Students draw only in their own frame.** Strokes, shapes, moves and resizes stop at its edge. Presses outside
   it pan the board. They can't change frames, other students' work or the teacher's work outside their frame. They
   also can't add pictures, import files or draw with AI while classroom mode is on.
5. **The teacher stays free.** The owner and invited editors draw anywhere, can move frames (a student's work moves
   with their frame), and can **Free** a claimed frame from its panel. That's the way to let a student move frames, or
   take their frame back on another device.
6. **End** turns it off and everyone draws freely again. Claims are kept, so starting it again picks up where the
   class left off. Classroom mode and its claims are saved with the board.

With private mode also on, each student's work is hidden from the others until the teacher reveals it, and it still
can't go outside their frame.

## Who is a student

Anyone the board lets edit who isn't one of its members: people on the edit link, guests or signed in. The owner and
invited editors are teachers. Viewers can only look, as always.

## How it's enforced

- **The server decides.** In `server/src/realtime/classroom.ts`, a student's change is checked element by element
  against their frame, using the rule in `shared/src/zones.ts`. That rule works only from stored numbers, so the
  browser and server always agree. Text width is estimated from its characters, and a line or arrow counts by its two
  ends. Whatever was added, changed or removed outside the frame is left out, and the student's screen puts it back
  (`cleaned`, `dropped` and `restored` in the reply), with nothing else lost. A change through the public API is taken
  whole or not at all. Suggestions in private mode are held to the same rule.
- **The browser keeps students inside** (`client/src/features/board/classroom.ts`), so the server almost never has
  to refuse anything. What a student's changes make must also fit inside the frame as it's drawn, strokes included.
  That is what decides what a frame holds, so a student's work moves with their frame when the teacher moves it.

## Limits

- Everything inside a student's frame is theirs to change, including what the teacher put there (the question on a
  worksheet, say). Undo puts it back.
- A guest is known by an id kept in their browser. On another device, the teacher frees their frame and they claim it
  again. A signed-in student keeps their frame on any device.
- The whole class shares one board's limits: 5,000 elements and 12 MB, about 160 elements each for 30 students.
