import {startServer} from "../../index.js";
try {const started=await startServer();process.send?.({type:"held-started",port:started.listenPort});}
catch(error){process.send?.({type:"held-failed",message:error instanceof Error?error.message:"startup_failed"});process.exitCode=1;process.disconnect?.();}
