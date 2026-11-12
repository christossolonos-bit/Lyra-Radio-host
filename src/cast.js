// Who can join Lyra on the podcast. A guest only appears once their Fish voice is set in .env.
// side: which side of Lyra their card sits on, so they face her (Nova looks right, Solo looks left).

export const CAST = {
  Nova:   { voiceEnv: "FISH_VOICE_NOVA",   image: "cast/nova.jpg",   side: "left",  color: "#ffcf9e" },
  Marcus: { voiceEnv: "FISH_VOICE_MARCUS", image: "cast/marcus.jpg", side: "left",  color: "#c9d4da" },
  Juno:   { voiceEnv: "FISH_VOICE_JUNO",   image: "cast/juno.jpg",   side: "left",  color: "#f2dd86" },
  Solo:   { voiceEnv: "FISH_VOICE_SOLO",   image: "cast/solo.jpg",   side: "right", color: "#f0a8a0" },
};

export const voiceOf = (name) => process.env[CAST[name]?.voiceEnv] || "";
export const availableGuests = () => Object.keys(CAST).filter((n) => voiceOf(n));
export const guestCard = (name) => ({ name, ...CAST[name] });
