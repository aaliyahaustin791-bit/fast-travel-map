// Import the SillyTavern context to access internal APIs
import { getContext } from "../../../extensions.js";

// This runs when the extension loads
const load = () => {
    const context = getContext();
    console.log("My extension loaded!");
    console.log("Current chat:", context.chat);
    
    // Example: Add a button to the UI
    const button = document.createElement("button");
    button.textContent = "Click Me";
    button.onclick = () => alert("Extension works!");
    document.body.appendChild(button);
};

// Register the load function
load();
