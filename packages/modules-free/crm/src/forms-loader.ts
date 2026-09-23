/**
 * The embed script.
 *
 * One tag on somebody's website:
 *
 *   <script src="https://their-instance/embed.js"
 *           data-sentrello-form="abc123"></script>
 *
 * It renders the form where the tag sits, posts it, and shows the result —
 * without the site owner writing any HTML. The previous embed handed them a
 * `<form>` to paste, which meant every change to a field was a change to their
 * website, and every site drifted out of step with the form it was showing.
 *
 * Served as a string rather than a built asset because it must run on any
 * site, in any bundler or none, with no framework and no imports. It is small
 * enough to read in one sitting, which is the point: anyone can check what
 * they are pasting onto their own page.
 */

/**
 * Everything a caller sends is escaped before it reaches innerHTML.
 *
 * A form's labels are written by the business, but the definition travels
 * through the browser of whoever is filling it in — and the script runs on the
 * customer's own site, where an injection would be theirs to explain, not
 * ours.
 */
const SCRIPT = String.raw`(function () {
  var tag = document.currentScript;
  if (!tag) return;
  var key = tag.getAttribute("data-sentrello-form");
  if (!key) return;
  var base = new URL(tag.src, window.location.href).origin;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var host = document.createElement("div");
  host.className = "sentrello-form";
  tag.parentNode.insertBefore(host, tag.nextSibling);

  fetch(base + "/api/embed/forms/" + encodeURIComponent(key), {
    credentials: "omit",
  })
    .then(function (r) {
      if (!r.ok) throw new Error("form unavailable");
      return r.json();
    })
    .then(function (form) {
      var style = form.style || {};
      // The brand, for a business that has not chosen its own. It is drawn on
      // somebody else's website, so it was the one place the old teal would
      // have outlived the rest of the product.
      var accent = /^#[0-9a-fA-F]{3,8}$/.test(style.accent || "")
        ? style.accent
        : "#c4470f";
      var radius = /^[0-9.]+(px|rem|em)$/.test(style.radius || "")
        ? style.radius
        : "6px";

      var css = document.createElement("style");
      css.textContent =
        /*
         * A grid, so a field can take half a row.
         *
         * Name beside email is the single most requested shape and it was not
         * possible: every field was a block in one column. A form is two
         * columns now and a field spans both unless it says otherwise, which
         * keeps every form that already exists looking exactly as it did.
         *
         * It collapses to one column under 26rem — narrower than a phone, and
         * about the width somebody drops a form into a sidebar at, where two
         * columns of inputs is worse than none.
         */
        /*
         * The grid goes on the form, not on the host.
         *
         * The .sentrello-form class is on the div this script inserts; the
         * form element is inside it, next to the stylesheet. Putting the grid
         * on the host laid out two children — a style tag and a form — so
         * every field stayed in one column, which looked exactly like the
         * half-width option not working.
         */
        ".sentrello-form{font:inherit;max-width:32rem}" +
        ".sentrello-form form{display:grid;grid-template-columns:1fr 1fr;gap:0 .75rem}" +
        ".sentrello-form form > *{grid-column:1 / -1}" +
        ".sentrello-form form > .sentrello-half{grid-column:span 1}" +
        "@media (max-width:26rem){.sentrello-form form > .sentrello-half{grid-column:1 / -1}}" +
        /* An optional field says so, rather than every other one shouting. */
        ".sentrello-form .sentrello-optional{float:right;font-weight:400;opacity:.6}" +
        ".sentrello-form label,.sentrello-form .sentrello-group{display:block;margin:.6rem 0 .2rem;font-size:.875rem}" +
        ".sentrello-form .sentrello-field{min-width:0}" +
        ".sentrello-form input,.sentrello-form textarea,.sentrello-form select{width:100%;padding:.5rem;" +
        "border:1px solid #cbd5e1;border-radius:" + radius + ";font:inherit;box-sizing:border-box}" +
        /* justify-self, so the button is its own width. A grid child fills
           its track by default, and a Send button as wide as the form reads
           as a banner rather than as a thing to press. */
        ".sentrello-form button{margin-top:.8rem;padding:.55rem 1.1rem;border:0;cursor:pointer;justify-self:start;" +
        "border-radius:" + radius + ";background:" + accent + ";color:#fff;font:inherit}" +
        ".sentrello-form .sentrello-msg{margin-top:.6rem;font-size:.9rem}" +
        /*
         * Radio options as cards, not as a bare column of dots.
         *
         * A radio group is the one control a visitor reads before choosing
         * rather than after, so the whole option is the target: the label
         * wraps the input, the box has a border, and it lights up when
         * checked. The :has() selector does the highlight with no script,
         * which is why this is a stylesheet rather than a listener.
         *
         * The grid collapses to one column under 24rem, which is narrower
         * than most phones but exactly the width somebody embeds a form into
         * a sidebar at.
         */
        ".sentrello-form .sentrello-opts{display:grid;gap:.5rem;grid-template-columns:1fr 1fr;margin:.2rem 0 .1rem}" +
        "@media (max-width:24rem){.sentrello-form .sentrello-opts{grid-template-columns:1fr}}" +
        ".sentrello-form .sentrello-opt{display:flex;align-items:center;gap:.5rem;margin:0;padding:.55rem .7rem;" +
        "border:1px solid #cbd5e1;border-radius:" + radius + ";cursor:pointer;font-size:.9375rem}" +
        ".sentrello-form .sentrello-opt:has(input:checked){border-color:" + accent + ";box-shadow:inset 0 0 0 1px " + accent + "}" +
        ".sentrello-form .sentrello-opt:has(input:focus-visible){outline:2px solid " + accent + ";outline-offset:2px}" +
        ".sentrello-form .sentrello-opt input{width:auto;margin:0;padding:0;flex:none}" +
        ".sentrello-credit{margin-top:1.25rem;font-size:.8125rem;opacity:.7}" +
        ".sentrello-hp{position:absolute!important;left:-9999px!important}";
      host.appendChild(css);

      var html = "<form novalidate>";
      (form.fields || []).forEach(function (f) {
        var id = "sf-" + key + "-" + esc(f.name);
        // "date" is a native input type, so the visitor gets their own phone's
        // date picker rather than a script we would have to ship and keep
        // accessible. "select" is the one field that is not an input at all.
        var type = ["email", "tel", "number", "url", "date", "textarea", "select", "radio"].indexOf(f.type) >= 0 ? f.type : "text";
        var control;
        if (type === "radio") {
          /*
           * Every option visible at once, which is the whole reason to pick
           * this over a dropdown: a visitor who can see the four answers
           * picks the right one, and a visitor who has to open a menu picks
           * the first.
           *
           * Nothing is checked to begin with. A radio group with a default
           * is a question the visitor never answers — they submit whatever
           * was already selected — and on a form that routes an enquiry,
           * that is the answer being wrong quietly.
           */
          var opts = "";
          (f.options || []).forEach(function (o, i) {
            var oid = id + "-" + i;
            opts +=
              '<label class="sentrello-opt" for="' + oid + '">' +
              '<input type="radio" id="' + oid + '" name="' + esc(f.name) + '" value="' + esc(o) + '"' +
              (f.required ? " required" : "") + ">" +
              "<span>" + esc(o) + "</span></label>";
          });
          control = '<div class="sentrello-opts" role="radiogroup" aria-labelledby="' + id + '">' + opts + "</div>";
        } else if (type === "textarea") {
          control = '<textarea id="' + id + '" name="' + esc(f.name) + '" rows="4"' + (f.required ? " required" : "") + "></textarea>";
        } else if (type === "select") {
          // A blank first option, and it carries the "required" refusal: a
          // dropdown that starts on a real answer is one the visitor submits
          // without reading, and the first option is never the honest default.
          var options = '<option value="">' + (f.required ? "Choose one" : "\u2014") + "</option>";
          (f.options || []).forEach(function (o) {
            options += "<option>" + esc(o) + "</option>";
          });
          control = '<select id="' + id + '" name="' + esc(f.name) + '"' + (f.required ? " required" : "") + ">" + options + "</select>";
        } else {
          control = '<input id="' + id + '" type="' + type + '" name="' + esc(f.name) + '"' + (f.required ? " required" : "") + ">";
        }
        /*
         * A radio group is labelled, not pointed at.
         *
         * A "label for" names one control, and a group of four radios has
         * no single one to name — the browser would tie the question to the
         * first option, and a screen reader would read "What brings you here?
         * Talk to us" as one answer. So the group gets a plain element with
         * an id, and aria-labelledby on the radiogroup points back at it.
         */
        /*
         * Label and control travel together.
         *
         * They are two siblings in a grid, so a half-width field has to wrap
         * them or the label takes one cell and its input takes the next —
         * which puts "Work email" above the name box. Wrapping is also what
         * makes the pair move as one when a form is rearranged.
         */
        var half = f.half === true ? " sentrello-half" : "";
        var heading =
          (type === "radio"
            ? '<span class="sentrello-group" id="' + id + '">'
            : '<label for="' + id + '">') +
          esc(f.label || f.name) +
          (f.required
            ? " *"
            : '<span class="sentrello-optional">Optional</span>') +
          (type === "radio" ? "</span>" : "</label>");
        html += '<div class="sentrello-field' + half + '">' + heading + control + "</div>";
      });
      // The honeypot the server already checks. Hidden off-screen rather than
      // display:none, which some bots know to skip.
      html +=
        '<input class="sentrello-hp" tabindex="-1" autocomplete="off" name="' +
        esc(form.honeypot) + '">' +
        "<button type=submit>Send</button>" +
        '<div class="sentrello-msg" role="status"></div></form>';
      host.insertAdjacentHTML("beforeend", html);

      var el = host.querySelector("form");
      var msg = host.querySelector(".sentrello-msg");
      el.addEventListener("submit", function (e) {
        e.preventDefault();
        var button = el.querySelector("button");
        button.disabled = true;
        msg.textContent = "Sending…";

        fetch(base + "/api/embed/forms/" + encodeURIComponent(key), {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "omit",
          body: JSON.stringify(
            Array.prototype.reduce.call(
              new FormData(el).entries(),
              function (acc, pair) { acc[pair[0]] = pair[1]; return acc; },
              {},
            ),
          ),
        })
          .then(function (r) {
            if (!r.ok) throw new Error("failed");
            return r.json().catch(function () { return {}; });
          })
          .then(function (out) {
            if (form.redirectUrl) {
              window.location.href = form.redirectUrl;
              return;
            }
            // Replaced rather than cleared: a form that empties itself looks
            // like it lost what was typed.
            host.innerHTML = "";
            host.appendChild(css);
            var done = document.createElement("p");
            done.className = "sentrello-msg";
            done.textContent = out.message || "Thanks — we have your message.";
            host.appendChild(done);

            /*
             * The same credit the plain-HTML reply carries. Built as elements
             * rather than markup: this runs on somebody else's site, and the
             * text comes from a business's own settings.
             */
            if (out.credit && out.credit.text) {
              var credit = document.createElement("p");
              credit.className = "sentrello-credit";
              if (out.credit.url) {
                var link = document.createElement("a");
                link.href = out.credit.url;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = out.credit.text;
                credit.appendChild(link);
              } else {
                credit.textContent = out.credit.text;
              }
              host.appendChild(credit);
            }
          })
          .catch(function () {
            button.disabled = false;
            msg.textContent = "That did not send. Please try again.";
          });
      });
    })
    .catch(function () {
      // Silent on the page. A site owner whose allow-list is wrong should not
      // have an error printed to their visitors; the console is where they
      // will look.
      if (window.console) console.warn("[sentrello] form " + key + " unavailable");
    });
})();`;

export function embedScript(): string {
  return SCRIPT;
}
