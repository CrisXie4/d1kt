const { createServer } = require("./src/server");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const server = createServer();

server.listen(port, () => {
  console.log(`Server listening on http://127.0.0.1:${port}`);
});
