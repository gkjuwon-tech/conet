import { useNavigate } from "react-router-dom";

export function Onboarding() {
  const nav = useNavigate();
  return (
    <div className="onboarding-stage">
      <section className="onboarding-card" data-fade>
        <header>
          <span className="eyebrow">Step 2 of 3 · Choose your path</span>
          <h1>How do you want to start earning?</h1>
          <p className="lede">
            You can sweep every device on your home network in 30 seconds,
            register the machine you're sitting at, or skip ahead to the
            dashboard and add devices later.
          </p>
        </header>

        <div className="onboarding-choices">
          <button
            type="button"
            className="onboarding-choice"
            onClick={() => nav("/devices/lan")}
          >
            <span className="onboarding-choice__title">Sweep my LAN</span>
            <span className="onboarding-choice__lede">
              We'll probe every device on your network — routers, phones, IoT,
              servers — and let you pair them in one batch. Friend-or-foe filter
              keeps things you don't own out of the list.
            </span>
            <span className="onboarding-choice__hint">Fastest · ~30 seconds</span>
          </button>

          <button
            type="button"
            className="onboarding-choice"
            onClick={() => nav("/devices/new")}
          >
            <span className="onboarding-choice__title">Just this computer</span>
            <span className="onboarding-choice__lede">
              Register the machine you're using right now. The agent will
              benchmark it and start earning whenever your CPU is idle.
            </span>
            <span className="onboarding-choice__hint">Local · ~10 seconds</span>
          </button>

          <button
            type="button"
            className="onboarding-choice"
            onClick={() => nav("/devices/android")}
          >
            <span className="onboarding-choice__title">Pair my Android</span>
            <span className="onboarding-choice__lede">
              Use Wireless Debugging to enroll your Android phone or tablet
              over the LAN. No sideloading, no app store. PIN-based pairing
              that asks the phone to consent.
            </span>
            <span className="onboarding-choice__hint">Phones · ~2 minutes</span>
          </button>

          <button
            type="button"
            className="onboarding-choice"
            onClick={() => nav("/")}
          >
            <span className="onboarding-choice__title">Skip for now</span>
            <span className="onboarding-choice__lede">
              Browse the dashboard without registering anything. You can pair
              devices any time from the Devices page.
            </span>
            <span className="onboarding-choice__hint">Just looking</span>
          </button>
        </div>
      </section>
    </div>
  );
}
