// Published XEP-0115 v1.6.0 §§5.2–5.3 XML examples and verification strings.
// https://xmpp.org/extensions/xep-0115.html#ver-simple
// https://xmpp.org/extensions/xep-0115.html#ver-complex
export const INFO = "http://jabber.org/protocol/disco#info";
export const DATA = "jabber:x:data";
export const SIMPLE_IDENTITY =
  '<identity category="client" type="pc" name="Exodus 0.9.1"/>';
export const FEATURES = [
  "http://jabber.org/protocol/caps",
  "http://jabber.org/protocol/disco#info",
  "http://jabber.org/protocol/disco#items",
  "http://jabber.org/protocol/muc",
] as const;
export const SIMPLE_XML = `<query xmlns="${INFO}">
  ${SIMPLE_IDENTITY}
  <feature var="http://jabber.org/protocol/caps"/>
  <feature var="http://jabber.org/protocol/disco#info"/>
  <feature var="http://jabber.org/protocol/disco#items"/>
  <feature var="http://jabber.org/protocol/muc"/>
</query>`;
export const SIMPLE_CANONICAL =
  "client/pc//Exodus 0.9.1<" +
  "http://jabber.org/protocol/caps<" +
  "http://jabber.org/protocol/disco#info<" +
  "http://jabber.org/protocol/disco#items<" +
  "http://jabber.org/protocol/muc<";
export const SIMPLE_SHA1 = "QgayPKawpkPSDYmwT/WM94uAlu0=";
export const COMPLEX_XML = `<query xmlns="${INFO}" node="http://psi-im.org#q07IKJEyjvHSyhy//CH0CxmKi8w=">
  <identity xml:lang="en" category="client" name="Psi 0.11" type="pc"/>
  <identity xml:lang="el" category="client" name="Ψ 0.11" type="pc"/>
  <feature var="http://jabber.org/protocol/caps"/>
  <feature var="http://jabber.org/protocol/disco#info"/>
  <feature var="http://jabber.org/protocol/disco#items"/>
  <feature var="http://jabber.org/protocol/muc"/>
  <x xmlns="${DATA}" type="result">
    <field var="FORM_TYPE" type="hidden"><value>urn:xmpp:dataforms:softwareinfo</value></field>
    <field var="ip_version" type="text-multi"><value>ipv4</value><value>ipv6</value></field>
    <field var="os"><value>Mac</value></field>
    <field var="os_version"><value>10.5.1</value></field>
    <field var="software"><value>Psi</value></field>
    <field var="software_version"><value>0.11</value></field>
  </x>
</query>`;
// The source XML uses ASCII spaces; the rendered explanatory formula has NBSPs.
export const COMPLEX_CANONICAL =
  "client/pc/el/Ψ 0.11<client/pc/en/Psi 0.11<" +
  "http://jabber.org/protocol/caps<" +
  "http://jabber.org/protocol/disco#info<" +
  "http://jabber.org/protocol/disco#items<" +
  "http://jabber.org/protocol/muc<" +
  "urn:xmpp:dataforms:softwareinfo<" +
  "ip_version<ipv4<ipv6<os<Mac<os_version<10.5.1<" +
  "software<Psi<software_version<0.11<";
export const COMPLEX_SHA1 = "q07IKJEyjvHSyhy//CH0CxmKi8w=";
