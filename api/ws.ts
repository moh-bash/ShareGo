import server from "../signaling/vercel-server";

export const maxDuration = 300;

export const config = {
  api: {
    bodyParser: false,
  },
};

export default server;
